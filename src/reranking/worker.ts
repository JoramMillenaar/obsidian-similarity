import { AutoTokenizer, PreTrainedModel, PreTrainedTokenizer, ProgressInfo, Tensor, XLMRobertaForSequenceClassification } from '@huggingface/transformers';
import { describeLoadFailure, detectWebGpu, isModelCached } from '../embedding/host/model';
import { Device } from '../ports';
import { RerankerModelConfig } from '../types';
import { RerankerRequest, RerankerResponse } from './protocol';

/**
 * Worker side of the reranker: loads the cross-encoder once, then scores (search, passage)
 * pairs one request at a time, a batch at a time, so a cancelled request stops at the next
 * batch. There is no dispose: the host terminates the worker, which is what frees its memory.
 */

type Variant = { device: Device; dtype: 'fp16' | 'q8' };

const WASM_VARIANT: Variant = {device: 'wasm', dtype: 'q8'};

type Loaded = {
	config: RerankerModelConfig;
	tokenizer: PreTrainedTokenizer;
	model: PreTrainedModel;
	device: Device;
};

type Post = (message: RerankerResponse) => void;

let loading: Promise<Loaded> | null = null;
let scoring: Promise<void> = Promise.resolve();
/** Score requests not yet answered, so a cancel arriving after the answer leaves nothing behind. */
const unanswered = new Set<number>();
const cancelled = new Set<number>();

function sigmoid(logit: number): number {
	return 1 / (1 + Math.exp(-logit));
}

/**
 * Lets queued messages (a cancel) in. Inference only awaits microtasks, so without this a cancel
 * would wait out the whole request. A message rather than a timer, which a hidden window throttles.
 */
function yieldToMessages(): Promise<void> {
	return new Promise((resolve) => {
		const channel = new MessageChannel();
		channel.port1.onmessage = () => resolve();
		channel.port2.postMessage(null);
	});
}

async function load(config: RerankerModelConfig, allowWebGpu: boolean, post: Post): Promise<Loaded> {
	// The model's fp32 weights are 1.1 GB: without fp16 shaders, int8 weights on the CPU are the better trade.
	const {available, f16} = allowWebGpu ? await detectWebGpu() : {available: false, f16: false};
	const preferred: Variant = available && f16 ? {device: 'webgpu', dtype: 'fp16'} : WASM_VARIANT;

	if (!navigator.onLine && !(await isModelCached(config.repoId))) {
		throw new Error(`The ${config.label} model has not been downloaded yet, and you appear to be offline.`);
	}

	const progress_callback = (info: ProgressInfo) => {
		if (info.status === 'progress') {
			post({type: 'reranker-progress', progress: info.progress, file: info.file, loaded: info.loaded, total: info.total});
		}
	};
	const loadModel = (variant: Variant) => XLMRobertaForSequenceClassification.from_pretrained(config.repoId, {
		device: variant.device,
		dtype: variant.dtype,
		progress_callback,
	});

	try {
		const tokenizer = await AutoTokenizer.from_pretrained(config.repoId, {progress_callback});
		try {
			return {config, tokenizer, model: await loadModel(preferred), device: preferred.device};
		} catch (error) {
			if (preferred.device !== 'webgpu') throw error;
			console.warn('[Similarity] WebGPU backend failed to load the reranker; falling back to WASM.', error);
			return {config, tokenizer, model: await loadModel(WASM_VARIANT), device: WASM_VARIANT.device};
		}
	} catch (error) {
		throw new Error(describeLoadFailure(error, config));
	}
}

/** Relevance (0–1) of each passage to `query`, or null if the request was cancelled midway. */
async function score({config, tokenizer, model, device}: Loaded, requestId: number, query: string, passages: string[]): Promise<number[] | null> {
	const batchSize = device === 'webgpu' ? config.gpuBatchSize : 1;
	const scores: number[] = [];
	for (let at = 0; at < passages.length; at += batchSize) {
		if (at > 0) await yieldToMessages();
		if (cancelled.has(requestId)) return null;
		const batch = passages.slice(at, at + batchSize);
		const inputs = tokenizer(batch.map(() => query), {
			text_pair: batch,
			padding: true,
			truncation: true,
			max_length: config.maxTokens,
		});
		const {logits} = await model(inputs) as { logits: Tensor };
		for (const logit of logits.to('float32').data as Float32Array) scores.push(sigmoid(logit));
	}
	return scores;
}

async function answer(message: RerankerRequest & { type: 'reranker-score' }, post: Post): Promise<void> {
	const {requestId, query, passages} = message;
	try {
		if (!loading) throw new Error('The reranker has not been initialized');
		const scores = await score(await loading, requestId, query, passages);
		if (scores) post({type: 'reranker-scores', requestId, scores});
	} catch (error) {
		post({type: 'reranker-score-error', requestId, message: error instanceof Error ? error.message : String(error)});
	} finally {
		unanswered.delete(requestId);
		cancelled.delete(requestId);
	}
}

export async function handleRerankerRequest(message: RerankerRequest, post: Post): Promise<void> {
	if (message.type === 'reranker-init') {
		if (loading) {
			console.error("[Similarity] Reranker worker received a second 'init' message; ignoring it.");
			return;
		}
		loading = load(message.config, message.allowWebGpu, post);
		try {
			post({type: 'reranker-ready', device: (await loading).device});
		} catch (error) {
			post({type: 'reranker-load-error', message: error instanceof Error ? error.message : String(error)});
		}
		return;
	}

	if (message.type === 'reranker-score') {
		unanswered.add(message.requestId);
		scoring = scoring.then(() => answer(message, post));
		return;
	}

	if (unanswered.has(message.requestId)) cancelled.add(message.requestId);
}

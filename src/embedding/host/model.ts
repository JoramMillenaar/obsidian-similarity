import { env, pipeline, FeatureExtractionPipeline, ProgressInfo, Tensor } from '@huggingface/transformers';
import { EmbeddingModelConfig, EmbeddingQuant } from '../../types';
import { Device, ModelLoadProgressCallback } from './types';
import { EmbedLane } from '../../ports';
import { InferenceQueue } from './inferenceQueue';

env.allowLocalModels = false;

const TRANSFORMERS_CACHE = 'transformers-cache';
const cacheKeyFor = (repoId: string, file: string) => `https://huggingface.co/${repoId}/resolve/main/${file}`;

async function isModelCached(repoId: string): Promise<boolean> {
	if (typeof caches === 'undefined') return true;
	try {
		const cache = await caches.open(TRANSFORMERS_CACHE);
		return (await cache.match(cacheKeyFor(repoId, 'config.json'))) !== undefined;
	} catch {
		return true;
	}
}

type GpuAdapterLike = { features: { has(feature: string): boolean } };
type GpuLike = { requestAdapter(): Promise<GpuAdapterLike | null> };

/**
 * `navigator.gpu` being defined only means the WebGPU API exists, not that a GPU adapter is
 * actually obtainable — some Android WebViews (and Chrome without the unsafe-webgpu flag) expose
 * the API but fail `requestAdapter()`. Actually requesting the adapter is the only way to know,
 * and doubles as the shader-f16 feature check, since that also needs an adapter.
 */
async function detectWebGpu(): Promise<{available: boolean; f16: boolean}> {
	const gpu = (navigator as Navigator & { gpu?: GpuLike }).gpu;
	if (gpu == null) return {available: false, f16: false};
	try {
		const adapter = await gpu.requestAdapter();
		if (adapter == null) return {available: false, f16: false};
		return {available: true, f16: adapter.features.has('shader-f16')};
	} catch {
		return {available: false, f16: false};
	}
}

type ModelVariant = {
	device: Device;
	dtype: 'fp16' | 'fp32' | 'q8';
	modelFileName?: string;
	quant: EmbeddingQuant;
};

const WASM_VARIANT: ModelVariant = {device: 'wasm', dtype: 'q8', quant: {vocab: 'q8', ffn: 'q8'}};

function webGpuVariant(f16: boolean): ModelVariant {
	const ffn = f16 ? 'fp16' : 'fp32';
	return {device: 'webgpu', dtype: ffn, modelFileName: 'model_vocab4', quant: {vocab: 'q4', ffn}};
}

type SpecialTokens = {prefix: number[]; suffix: number[]};

type Tokenizer = FeatureExtractionPipeline['tokenizer'];

function specialTokensOf(tokenizer: Tokenizer): SpecialTokens {
	const bare = tokenizer.encode('a', {add_special_tokens: false});
	const full = tokenizer.encode('a', {add_special_tokens: true});
	for (let at = 0; at + bare.length <= full.length; at++) {
		if (bare.every((id, i) => full[at + i] === id)) {
			return {prefix: full.slice(0, at), suffix: full.slice(at + bare.length)};
		}
	}
	return {prefix: [], suffix: []};
}

type RowRange = [start: number, end: number];

function meanPool(hidden: Float32Array, dim: number, ranges: RowRange[]): Float32Array {
	const pooled = new Float32Array(dim);
	let count = 0;
	for (const [start, end] of ranges) {
		for (let row = start; row < end; row++) {
			const offset = row * dim;
			for (let k = 0; k < dim; k++) pooled[k] += hidden[offset + k];
			count++;
		}
	}
	if (count > 0) for (let k = 0; k < dim; k++) pooled[k] /= count;
	return pooled;
}

function int64Tensor(values: number[]): Tensor {
	return new Tensor('int64', BigInt64Array.from(values, (value) => BigInt(value)), [1, values.length]);
}

function describeLoadFailure(error: unknown, config: EmbeddingModelConfig): string {
	const detail = error instanceof Error ? error.message : String(error);
	const looksLikeNetwork = !navigator.onLine || /failed to fetch|network|load model file/i.test(detail);
	if (looksLikeNetwork) {
		return `Could not download the ${config.label} model. Check your internet connection and try again.`;
	}
	return `Could not load the ${config.label} model: ${detail}`;
}

export class EmbeddingModel {
	#pipeline: FeatureExtractionPipeline | null = null;
	#specialTokens: SpecialTokens = {prefix: [], suffix: []};
	#variant: ModelVariant = WASM_VARIANT;
	readonly #queue = new InferenceQueue();
	#disposed = false;
	readonly config: EmbeddingModelConfig;
	ready: Promise<void>;

	constructor(config: EmbeddingModelConfig, onProgress?: ModelLoadProgressCallback, allowWebGpu = true) {
		this.config = config;
		this.ready = this.#initialize(onProgress, allowWebGpu);
	}

	async #initialize(onProgress: ModelLoadProgressCallback | undefined, allowWebGpu: boolean): Promise<void> {
		const {available: webgpuAvailable, f16: f16Available} = allowWebGpu
			? await detectWebGpu()
			: {available: false, f16: false};
		this.#variant = webgpuAvailable ? webGpuVariant(f16Available) : WASM_VARIANT;

		if (!navigator.onLine && !(await isModelCached(this.config.repoId))) {
			throw new Error(
				`The ${this.config.label} model has not been downloaded yet, and you appear to be offline. `
				+ `Connect to the internet to finish setting up.`,
			);
		}

		let loaded: FeatureExtractionPipeline;
		try {
			loaded = await this.#load(this.#variant, onProgress);
		} catch (error) {
			if (this.#variant.device !== 'webgpu' || this.#disposed) {
				throw new Error(describeLoadFailure(error, this.config));
			}
			console.warn(`[Similarity] WebGPU backend failed to load the ${this.config.label} model; falling back to WASM.`, error);
			this.#variant = WASM_VARIANT;
			try {
				loaded = await this.#load(WASM_VARIANT, onProgress);
			} catch (wasmError) {
				throw new Error(describeLoadFailure(wasmError, this.config));
			}
		}

		if (this.#disposed) {
			await loaded.dispose();
			return;
		}
		this.#specialTokens = specialTokensOf(loaded.tokenizer);
		this.#pipeline = loaded;
	}

	#load(variant: ModelVariant, onProgress?: ModelLoadProgressCallback): Promise<FeatureExtractionPipeline> {
		return pipeline('feature-extraction', this.config.repoId, {
			device: variant.device,
			dtype: variant.dtype,
			model_file_name: variant.modelFileName,
			progress_callback: onProgress ? (info: ProgressInfo) => {
				if (info.status === 'progress') {
					onProgress({ progress: info.progress, file: info.file, loaded: info.loaded, total: info.total });
				}
			} : undefined,
		});
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;

		await this.#queue.close();

		const loaded = this.#pipeline;
		if (!loaded) return;
		this.#pipeline = null;
		await loaded.dispose();
	}

	countTokens = (text: string): number => {
		if (!this.#pipeline) throw new Error("pipeline not yet initialized");
		return this.#pipeline.tokenizer.encode(text, {add_special_tokens: false}).length;
	};

	embedSentences(sentences: string[], lane: EmbedLane): Promise<Float32Array[]> {
		return this.#queue.run(lane, async () => {
			const loaded = this.#pipeline;
			if (!loaded) throw new Error("pipeline not yet initialized");

			const {prefix, suffix} = this.#specialTokens;
			const contentEnd = this.config.maxTokens - suffix.length;
			const ids = [...prefix];
			const spans: RowRange[] = [];
			for (const sentence of sentences) {
				const start = ids.length;
				const tokens = loaded.tokenizer.encode(sentence, {add_special_tokens: false});
				ids.push(...tokens.slice(0, Math.max(0, contentEnd - start)));
				spans.push([start, ids.length]);
			}
			ids.push(...suffix);

			const output = await loaded.model({
				input_ids: int64Tensor(ids),
				attention_mask: int64Tensor(ids.map(() => 1)),
			});
			const states: Tensor = output.last_hidden_state ?? output.logits ?? output.token_embeddings;
			const hidden = states.to('float32');
			const data = hidden.data as Float32Array;
			const dim = hidden.dims[2];
			const edges: RowRange[] = [[0, prefix.length], [ids.length - suffix.length, ids.length]];
			return spans.map(([start, end]) => (
				end > start ? meanPool(data, dim, [[start, end], ...edges]) : new Float32Array(0)
			));
		});
	}

	getDevice(): Device {
		return this.#variant.device;
	}

	getQuant(): EmbeddingQuant {
		return this.#variant.quant;
	}
}

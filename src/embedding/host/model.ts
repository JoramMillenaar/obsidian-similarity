import { env, pipeline, FeatureExtractionPipeline, ProgressInfo } from '@huggingface/transformers';
import { EmbeddingModelConfig } from '../../types';
import { Device, ModelLoadProgressCallback } from './types';

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

function describeLoadFailure(error: unknown, config: EmbeddingModelConfig): string {
	const detail = error instanceof Error ? error.message : String(error);
	const looksLikeNetwork = !navigator.onLine || /failed to fetch|network|load model file/i.test(detail);
	if (looksLikeNetwork) {
		return `Could not download the ${config.label} model. Check your internet connection and try again.`;
	}
	return `Could not load the ${config.label} model: ${detail}`;
}

/** Wraps a single loaded transformers.js feature-extraction pipeline: loads it, runs serialized inference, and disposes it. */
export class EmbeddingModel {
	#pipeline: FeatureExtractionPipeline | null = null;
	#device: Device = 'wasm';
	#queue: Promise<unknown> = Promise.resolve(); // serialize all inference calls
	#disposed = false;
	readonly config: EmbeddingModelConfig;
	ready: Promise<void>;

	constructor(config: EmbeddingModelConfig, onProgress?: ModelLoadProgressCallback) {
		this.config = config;
		this.ready = this.#initialize(onProgress);
	}

	async #initialize(onProgress?: ModelLoadProgressCallback): Promise<void> {
		const {available: webgpuAvailable, f16: f16Available} = await detectWebGpu();
		this.#device = webgpuAvailable ? 'webgpu' : 'wasm';

		if (!navigator.onLine && !(await isModelCached(this.config.repoId))) {
			throw new Error(
				`The ${this.config.label} model has not been downloaded yet, and you appear to be offline. `
				+ `Connect to the internet to finish setting up.`,
			);
		}

		let loaded: FeatureExtractionPipeline;
		try {
			loaded = await this.#load(this.#device, webgpuAvailable ? (f16Available ? 'fp16' : 'fp32') : 'q8', onProgress);
		} catch (error) {
			if (this.#device !== 'webgpu' || this.#disposed) {
				throw new Error(describeLoadFailure(error, this.config));
			}
			console.warn(`[Similarity] WebGPU backend failed to load the ${this.config.label} model; falling back to WASM.`, error);
			this.#device = 'wasm';
			try {
				loaded = await this.#load('wasm', 'q8', onProgress);
			} catch (wasmError) {
				throw new Error(describeLoadFailure(wasmError, this.config));
			}
		}

		if (this.#disposed) {
			await loaded.dispose();
			return;
		}
		this.#pipeline = loaded;
	}

	#load(device: Device, dtype: 'fp16' | 'fp32' | 'q8', onProgress?: ModelLoadProgressCallback): Promise<FeatureExtractionPipeline> {
		return pipeline('feature-extraction', this.config.repoId, {
			device,
			dtype,
			progress_callback: onProgress ? (info: ProgressInfo) => {
				if (info.status === 'progress') {
					onProgress({ progress: info.progress, file: info.file, loaded: info.loaded, total: info.total });
				}
			} : undefined,
		});
	}

	/** Releases the underlying pipeline once any in-flight `embed` call has settled. Safe to call more than once. */
	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;

		const loaded = this.#pipeline;
		if (!loaded) return;
		this.#pipeline = null;

		await this.#queue.catch(() => undefined);
		await loaded.dispose();
	}

	/** Token count for `text` under this model's tokenizer, excluding special tokens. */
	countTokens = (text: string): number => {
		if (!this.#pipeline) throw new Error("pipeline not yet initialized");
		return this.#pipeline.tokenizer.encode(text, {add_special_tokens: false}).length;
	};

	/**
	 * Runs inference for `input`, queued behind any prior call so requests are serialized.
	 * Not normalized here — `embedDocument.ts` always L2-normalizes the result itself right
	 * before quantizing, so normalizing again at the pipeline level would just redo that work.
	 */
	embed(input: string): Promise<Float32Array> {
		return new Promise((resolve, reject) => {
			this.#queue = this.#queue.then(async () => {
				try {
					if (this.#disposed) return reject(new Error("model has been disposed"));
					if (!this.#pipeline) return reject(new Error("pipeline not yet initialized"));
					const result: { data: Float32Array } = await this.#pipeline(input, {
						pooling: this.config.pooling,
						normalize: false,
					});
					resolve(result.data);
				} catch (err) {
					reject(err instanceof Error ? err : new Error(String(err)));
				}
			});
		});
	}

	/** The compute backend ('wasm' or 'webgpu') this model ended up loading on. */
	getDevice(): Device {
		return this.#device;
	}
}

import { env, pipeline, FeatureExtractionPipeline, ProgressInfo } from '@huggingface/transformers';
import { EmbeddingModelConfig } from 'src/types';

env.allowLocalModels = false;

export type Device = 'wasm' | 'webgpu';
export type ModelLoadProgress = { progress: number; file: string; loaded: number; total: number };
export type ModelLoadProgressCallback = (progress: ModelLoadProgress) => void;

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
	#device: Device = 'wasm';
	#queue: Promise<unknown> = Promise.resolve(); // serialize all inference calls
	readonly config: EmbeddingModelConfig;
	ready: Promise<void>;

	constructor(config: EmbeddingModelConfig, onProgress?: ModelLoadProgressCallback) {
		this.config = config;
		this.ready = this.#initialize(onProgress);
	}

	async #initialize(onProgress?: ModelLoadProgressCallback): Promise<void> {
		const webgpuAvailable = (navigator as Navigator & { gpu?: unknown }).gpu != null;
		this.#device = webgpuAvailable ? 'webgpu' : 'wasm';

		try {
			this.#pipeline = await pipeline('feature-extraction', this.config.repoId, {
				device: this.#device,
				dtype: webgpuAvailable ? 'fp16' : 'q8',
				progress_callback: onProgress ? (info: ProgressInfo) => {
					if (info.status === 'progress') {
						onProgress({ progress: info.progress, file: info.file, loaded: info.loaded, total: info.total });
					}
				} : undefined,
			});
		} catch (error) {
			throw new Error(describeLoadFailure(error, this.config));
		}
	}

	countTokens = (text: string): number => {
		if (!this.#pipeline) throw new Error("pipeline not yet initialized");
		return this.#pipeline.tokenizer.encode(text, {add_special_tokens: false}).length;
	};

	// Serialized single-text inference — each call waits for the previous.
	embed(input: string): Promise<Float32Array | null> {
		return new Promise((resolve, reject) => {
			this.#queue = this.#queue.then(async () => {
				try {
					if (!this.#pipeline) return reject(new Error("pipeline not yet initialized"));
					const result: { data: Float32Array } = await this.#pipeline(input, {
						pooling: this.config.pooling,
						normalize: true
					});
					resolve(result.data);
				} catch (err) {
					reject(err instanceof Error ? err : new Error(String(err)));
				}
			});
		});
	}

	getDevice(): Device {
		return this.#device;
	}
}

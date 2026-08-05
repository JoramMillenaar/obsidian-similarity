import { env, pipeline, FeatureExtractionPipeline } from '@huggingface/transformers';
import { EmbeddingModelConfig } from 'src/types';

env.allowLocalModels = false;

export type Device = 'wasm' | 'webgpu';

/**
 * Owns the on-device feature-extraction model: load lifecycle, device
 * selection, tokenization, and serialized inference. No chunking policy —
 * that's the chunker's job. The config passed in is the sole source of truth
 * for which model gets loaded — nothing in this file names a model itself.
 */
export class EmbeddingModel {
	#pipeline: FeatureExtractionPipeline | null = null;
	#device: Device = 'wasm';
	#queue: Promise<unknown> = Promise.resolve(); // serialize all inference calls
	readonly config: EmbeddingModelConfig;
	ready: Promise<void>;

	constructor(config: EmbeddingModelConfig) {
		this.config = config;
		this.ready = this.#initialize();
	}

	async #initialize(): Promise<void> {
		const webgpuAvailable = (navigator as Navigator & { gpu?: unknown }).gpu != null;
		this.#device = webgpuAvailable ? 'webgpu' : 'wasm';

		this.#pipeline = await pipeline('feature-extraction', this.config.repoId, {
			device: this.#device,
			dtype: webgpuAvailable ? 'fp32' : 'q8',
		});
	}

	countTokens = (text: string): number => {
		if (!this.#pipeline) throw new Error("pipeline not yet initialized");
		return this.#pipeline.tokenizer.encode(text, {add_special_tokens: false}).length;
	};

	// Serialized single-text inference — each call waits for the previous.
	embed(input: string): Promise<Float32Array | number[] | null> {
		return new Promise((resolve, reject) => {
			this.#queue = this.#queue.then(async () => {
				try {
					if (!this.#pipeline) return reject(new Error("pipeline not yet initialized"));
					const result: { data: Float32Array } = await this.#pipeline(input, {
						pooling: 'mean',
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

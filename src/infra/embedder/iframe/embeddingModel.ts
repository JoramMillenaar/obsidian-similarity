import { env, FeatureExtractionPipeline, pipeline } from '@huggingface/transformers';
import { EmbeddingModelConfig } from 'src/types';

env.allowLocalModels = false;

export type Device = 'wasm' | 'webgpu';

const SPECIAL_TOKEN_RESERVE = 2;

export class EmbeddingModel {
	#pipeline: FeatureExtractionPipeline | null = null;
	#device: Device = 'wasm';
	#queue: Promise<unknown> = Promise.resolve(); // serialize all inference calls
	#chunkTokenBudget = 0;
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
			dtype: webgpuAvailable ? 'fp16' : 'q8',
		});

		const prefixTokens = this.config.prefix ? this.#count(this.config.prefix) : 0;

		this.#chunkTokenBudget = Math.max(1, this.config.maxTokens - SPECIAL_TOKEN_RESERVE - prefixTokens);
	}

	#count(text: string): number {
		if (!this.#pipeline) throw new Error("pipeline not yet initialized");
		return this.#pipeline.tokenizer.encode(text, {add_special_tokens: false}).length;
	}

	countTokens = (text: string): number => this.#count(text);

	getChunkTokenBudget(): number {
		return this.#chunkTokenBudget;
	}

	embed(input: string): Promise<Float32Array | null> {
		return new Promise((resolve, reject) => {
			this.#queue = this.#queue.then(async () => {
				try {
					await this.ready;
					if (!this.#pipeline) return reject(new Error("pipeline not yet initialized"));

					const text = (this.config.prefix ?? '') + input;

					const result: { data: Float32Array } = await this.#pipeline(text, {
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

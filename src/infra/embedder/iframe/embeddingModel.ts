import { env, pipeline, FeatureExtractionPipeline } from '@huggingface/transformers';

env.allowLocalModels = false;

export type Device = 'wasm' | 'webgpu';

/**
 * Owns the on-device feature-extraction model: load lifecycle, device
 * selection, tokenization, and serialized inference. No chunking policy —
 * that's the chunker's job.
 */
export class EmbeddingModel {
	#pipeline: FeatureExtractionPipeline | null = null;
	#device: Device = 'wasm';
	#queue: Promise<unknown> = Promise.resolve(); // serialize all inference calls
	ready: Promise<void>;

	constructor() {
		this.ready = this.#initialize();
	}

	async #initialize(): Promise<void> {
		const webgpuAvailable = (navigator as Navigator & { gpu?: unknown }).gpu != null;
		this.#device = webgpuAvailable ? 'webgpu' : 'wasm';

		console.log(`[Similarity] Initializing on ${this.#device}`);

		this.#pipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
			device: this.#device,
			dtype: webgpuAvailable ? 'fp32' : 'q8',
		});

		console.log(`[Similarity] Model ready on ${this.#device}`);
	}

	countTokens = (text: string): number => {
		return this.#pipeline!.tokenizer.encode(text, { add_special_tokens: false }).length;
	};

	// Serialized single-text inference — each call waits for the previous.
	embed(input: string): Promise<Float32Array | number[] | null> {
		return new Promise((resolve, reject) => {
			this.#queue = this.#queue.then(async () => {
				try {
					const result = await this.#pipeline!(input, { pooling: 'mean', normalize: true });
					resolve(result.data as unknown as Float32Array);
				} catch (err) {
					reject(err);
				}
			});
		});
	}

	getDevice(): Device {
		return this.#device;
	}
}

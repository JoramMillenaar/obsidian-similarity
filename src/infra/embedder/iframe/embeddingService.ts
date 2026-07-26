import { env, pipeline, FeatureExtractionPipeline } from '@huggingface/transformers';
import { chunkText } from 'src/domain/textChunking';

env.allowLocalModels = false;

// Chunk sizing is model-driven. all-MiniLM-L6-v2 accepts 256 tokens per
// sequence; reserve two for the [CLS]/[SEP] specials the tokenizer adds.
// When the model becomes configurable, this budget moves with it.
const MODEL_MAX_TOKENS = 256;
const SPECIAL_TOKEN_RESERVE = 2;
const CHUNK_TOKEN_BUDGET = MODEL_MAX_TOKENS - SPECIAL_TOKEN_RESERVE;

interface EmbeddedChunk {
	embedding: number[];
	start: number;
	end: number;
}

interface IframeMessageEventData {
	requestId: number;
	payload: string;
	maxOverlapPercent?: number;
}

class DocumentEmbeddingController {
	#pipeline: FeatureExtractionPipeline | null = null;
	#device: 'wasm' | 'webgpu' = 'wasm';
	#queue: Promise<unknown> = Promise.resolve(); // serialize all inference calls
	ready: Promise<void>;

	constructor() {
		this.ready = this.#initializeModel();
	}

	async #initializeModel(): Promise<void> {
		const webgpuAvailable = (navigator as Navigator & { gpu?: unknown }).gpu != null;
		this.#device = webgpuAvailable ? 'webgpu' : 'wasm';

		console.log(`[Similarity] Initializing on ${this.#device}`);

		this.#pipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
			device: this.#device,
			dtype: webgpuAvailable ? 'fp32' : 'q8',
		});

		console.log(`[Similarity] Model ready on ${this.#device}`);
	}

	async generateDocumentEmbeddings(text: string, maxOverlapPercent?: number): Promise<EmbeddedChunk[]> {
		await this.ready;
		if (!text.trim()) return [];

		// Chunk the caller's string as-is, so the spans we report index into it.
		const chunks = chunkText(text, this.#countTokens, CHUNK_TOKEN_BUDGET, maxOverlapPercent);

		const embedded: EmbeddedChunk[] = [];
		for (const chunk of chunks) {
			const data = await this.#embed(chunk.text);
			if (data && data.length) {
				embedded.push({ embedding: Array.from(data), start: chunk.start, end: chunk.end });
			}
		}
		return embedded;
	}

	#countTokens = (text: string): number => {
		return this.#pipeline!.tokenizer.encode(text, { add_special_tokens: false }).length;
	};

	// Serialized single-text inference — each call waits for the previous.
	#embed(input: string): Promise<number[] | Float32Array | null> {
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

	getDevice(): 'wasm' | 'webgpu' {
		return this.#device;
	}
}

const embedder = new DocumentEmbeddingController();

window.addEventListener('message', async (event: MessageEvent<IframeMessageEventData>) => {
	const { requestId, payload, maxOverlapPercent } = event.data;

	if (payload === 'ping') {
		await embedder.ready;
		(event.source as Window).postMessage(
			{ requestId, data: [], device: embedder.getDevice() },
			window.origin
		);
		return;
	}

	try {
		const embeddings = await embedder.generateDocumentEmbeddings(payload, maxOverlapPercent);
		(event.source as Window).postMessage({ requestId, data: embeddings }, window.origin);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		(event.source as Window).postMessage({ requestId, data: [], error: message }, window.origin);
	}
});

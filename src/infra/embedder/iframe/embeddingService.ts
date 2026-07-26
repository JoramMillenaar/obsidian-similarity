import { env, pipeline, FeatureExtractionPipeline } from '@huggingface/transformers';

env.allowLocalModels = false;

// Chunk sizing is model-driven. all-MiniLM-L6-v2 accepts 256 tokens per
// sequence; reserve two for the [CLS]/[SEP] specials the tokenizer adds.
// When the model becomes configurable, this budget moves with it.
const MODEL_MAX_TOKENS = 256;
const SPECIAL_TOKEN_RESERVE = 2;
const CHUNK_TOKEN_BUDGET = MODEL_MAX_TOKENS - SPECIAL_TOKEN_RESERVE;
const MAX_OVERLAP_PERCENT = 50;

const sentenceSegmenter = new Intl.Segmenter('und', { granularity: 'sentence' });

interface Sentence {
	text: string;
	start: number;
	end: number;
}

interface TokenizedSentence extends Sentence {
	tokens: number;
}

interface Chunk {
	text: string;
	start: number;
	end: number;
}

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

// Yields each sentence with its span in `text`. Offsets are of the TRIMMED
// sentence, so a chunk's [start, end) maps back onto the caller's own string.
function segmentSentences(text: string): Sentence[] {
	const sentences: Sentence[] = [];
	for (const { segment, index } of sentenceSegmenter.segment(text)) {
		const trimmed = segment.trim();
		if (!trimmed) continue;
		const start = index + (segment.length - segment.trimStart().length);
		sentences.push({ text: trimmed, start, end: start + trimmed.length });
	}
	return sentences;
}

function sumTokens(sentences: TokenizedSentence[]): number {
	return sentences.reduce((total, sentence) => total + sentence.tokens, 0);
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
		const chunks = this.#chunkText(text, maxOverlapPercent);

		const embedded: EmbeddedChunk[] = [];
		for (const chunk of chunks) {
			const data = await this.#embed(chunk.text);
			if (data && data.length) {
				embedded.push({ embedding: Array.from(data), start: chunk.start, end: chunk.end });
			}
		}
		return embedded;
	}

	#countTokens(text: string): number {
		return this.#pipeline!.tokenizer.encode(text, { add_special_tokens: false }).length;
	}

	#chunkText(text: string, maxOverlapPercent?: number): Chunk[] {
		const clampedPercent = Math.max(0, Math.min(maxOverlapPercent ?? 0, MAX_OVERLAP_PERCENT));
		const overlapBudget = Math.floor((CHUNK_TOKEN_BUDGET * clampedPercent) / 100);

		const sentences: TokenizedSentence[] = segmentSentences(text)
			.map((sentence) => ({ ...sentence, tokens: this.#countTokens(sentence.text) }));
		if (sentences.length === 0) return [];

		const chunks: Chunk[] = [];
		let current: TokenizedSentence[] = [];
		let currentTokens = 0;

		// A chunk spans from its first sentence's start to its last one's end.
		const flush = () => {
			if (current.length === 0) return;
			chunks.push({
				text: current.map((sentence) => sentence.text).join(' '),
				start: current[0].start,
				end: current[current.length - 1].end,
			});
		};

		const overlapSeed = (): TokenizedSentence[] => {
			if (overlapBudget <= 0) return [];
			const seed: TokenizedSentence[] = [];
			let seedTokens = 0;
			for (let i = current.length - 1; i >= 0; i--) {
				if (seedTokens + current[i].tokens > overlapBudget) break;
				seed.unshift(current[i]);
				seedTokens += current[i].tokens;
			}
			return seed;
		};

		for (const sentence of sentences) {
			// A lone sentence over budget can't be packed with anything; give it
			// its own chunk and let the pipeline truncate it.
			if (sentence.tokens >= CHUNK_TOKEN_BUDGET) {
				flush();
				chunks.push({ text: sentence.text, start: sentence.start, end: sentence.end });
				current = [];
				currentTokens = 0;
				continue;
			}

			if (currentTokens + sentence.tokens > CHUNK_TOKEN_BUDGET && current.length > 0) {
				flush();
				current = overlapSeed();
				currentTokens = sumTokens(current);
				// Trim overlap until the incoming sentence fits the budget.
				while (current.length > 0 && currentTokens + sentence.tokens > CHUNK_TOKEN_BUDGET) {
					currentTokens -= current[0].tokens;
					current.shift();
				}
			}

			current.push(sentence);
			currentTokens += sentence.tokens;
		}

		flush();
		return chunks;
	}

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

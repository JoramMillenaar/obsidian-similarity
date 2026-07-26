import { chunkText } from 'src/domain/textChunking';
import { EmbeddedChunk } from 'src/ports/embeddingPort';
import { EmbeddingModel } from './embeddingModel';

// Chunk sizing is model-driven. all-MiniLM-L6-v2 accepts 256 tokens per
// sequence; reserve two for the [CLS]/[SEP] specials the tokenizer adds.
// When the model becomes configurable, this budget moves with it.
const MODEL_MAX_TOKENS = 256;
const SPECIAL_TOKEN_RESERVE = 2;
const CHUNK_TOKEN_BUDGET = MODEL_MAX_TOKENS - SPECIAL_TOKEN_RESERVE;

export type GenerateDocumentEmbeddings = (text: string, maxOverlapPercent?: number) => Promise<EmbeddedChunk[]>;

/** Orchestrates the domain chunker against the model adapter — the iframe's use case. */
export function makeGenerateDocumentEmbeddings(model: EmbeddingModel): GenerateDocumentEmbeddings {
	return async function generateDocumentEmbeddings(text, maxOverlapPercent) {
		await model.ready;
		if (!text.trim()) return [];

		// Chunk the caller's string as-is, so the spans we report index into it.
		const chunks = chunkText(text, model.countTokens, CHUNK_TOKEN_BUDGET, maxOverlapPercent);

		const embedded: EmbeddedChunk[] = [];
		for (const chunk of chunks) {
			const data = await model.embed(chunk.text);
			if (data && data.length) {
				embedded.push({ embedding: Array.from(data), start: chunk.start, end: chunk.end });
			}
		}
		return embedded;
	};
}

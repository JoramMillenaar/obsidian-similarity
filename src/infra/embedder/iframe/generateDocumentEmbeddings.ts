import { chunkText } from 'src/domain/textChunking';
import { normalizeEmbedding, quantizeEmbedding } from 'src/domain/embedding';
import { EmbeddedChunk, EmbeddingResult } from 'src/ports/embeddingPort';
import { EmbeddingModel } from './embeddingModel';

// Reserve two tokens for the [CLS]/[SEP] specials the tokenizer adds on top
// of the model's max sequence length.
const SPECIAL_TOKEN_RESERVE = 2;

export type GenerateDocumentEmbeddings = (text: string, maxOverlapPercent?: number, maxChunkSize?: number) => Promise<EmbeddingResult>;

/** Orchestrates the domain chunker against the model adapter — the iframe's use case. */
export function makeGenerateDocumentEmbeddings(model: EmbeddingModel): GenerateDocumentEmbeddings {
	const chunkTokenBudget = model.config.maxTokens - SPECIAL_TOKEN_RESERVE;

	return async function generateDocumentEmbeddings(text, maxOverlapPercent, maxChunkSize) {
		await model.ready;

		const metadata = {
			embeddingModelId: model.config.id,
			maxOverlapPercent: maxOverlapPercent ?? 0,
			maxChunkSize,
		};

		if (!text.trim()) return { chunks: [], metadata };

		if (maxChunkSize !== undefined && maxChunkSize > chunkTokenBudget) {
			throw new Error(`maxChunkSize (${maxChunkSize}) exceeds the model's max chunk size (${chunkTokenBudget})`);
		}

		// Chunk the caller's string as-is, so the spans we report index into it.
		const chunks = chunkText(text, model.countTokens, chunkTokenBudget, maxOverlapPercent);

		const embedded: EmbeddedChunk[] = [];
		for (const chunk of chunks) {
			const data = await model.embed(chunk.text);
			if (data && data.length) {
				embedded.push({ embedding: quantizeEmbedding(normalizeEmbedding(data)), start: chunk.start, end: chunk.end });
			}
		}
		return { chunks: embedded, metadata };
	};
}

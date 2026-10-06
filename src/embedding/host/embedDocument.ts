import { chunkText } from '../../core/text/chunking';
import { normalizeEmbedding, quantizeEmbedding } from '../../core/vector/similarity';
import { EmbeddedChunk } from '../../ports';
import { EmbeddingModel } from './model';
import { GenerateDocumentEmbeddings } from './types';

export type { GenerateDocumentEmbeddings } from './types';

// Reserve two tokens for the [CLS]/[SEP] specials the tokenizer adds on top
// of the model's max sequence length.
const SPECIAL_TOKEN_RESERVE = 2;

/** Builds a function that chunks a document to fit `model`'s token budget and embeds each chunk. */
export function makeGenerateDocumentEmbeddings(model: EmbeddingModel): GenerateDocumentEmbeddings {
	const chunkTokenBudget = model.config.maxTokens - SPECIAL_TOKEN_RESERVE;

	return async function generateDocumentEmbeddings(text, maxOverlapPercent) {
		await model.ready;

		const metadata = {
			embeddingModelId: model.config.id,
			quant: model.getQuant(),
		};

		if (!text.trim()) return { chunks: [], metadata };

		const chunks = chunkText(text, model.countTokens, chunkTokenBudget, maxOverlapPercent);

		const embedded: EmbeddedChunk[] = [];
		for (const chunk of chunks) {
			const data = await model.embed(chunk.text);
			if (data.length) {
				embedded.push({ embedding: quantizeEmbedding(normalizeEmbedding(data)), start: chunk.start, end: chunk.end });
			}
		}
		return { chunks: embedded, metadata };
	};
}

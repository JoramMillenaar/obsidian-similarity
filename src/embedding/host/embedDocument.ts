import { chunkText } from '../../core/text/chunking';
import { normalizeEmbedding, quantizeEmbedding } from '../../core/vector/similarity';
import { EmbeddedChunk } from '../../ports';
import { EmbeddingModel } from './model';
import { GenerateDocumentEmbeddings } from './types';

export type { GenerateDocumentEmbeddings } from './types';

// Reserve two tokens for the [CLS]/[SEP] specials the tokenizer adds on top
// of the model's max sequence length.
const SPECIAL_TOKEN_RESERVE = 2;

export function makeGenerateDocumentEmbeddings(model: EmbeddingModel): GenerateDocumentEmbeddings {
	const chunkTokenBudget = model.config.maxTokens - SPECIAL_TOKEN_RESERVE;

	return async function generateDocumentEmbeddings(text, lane) {
		await model.ready;

		const metadata = {
			embeddingModelId: model.config.id,
			quant: model.getQuant(),
		};

		if (!text.trim()) return { chunks: [], metadata };

		const {maxOverlapPercent, minSentenceWords} = model.config;
		const chunks = chunkText(text, model.countTokens, chunkTokenBudget, maxOverlapPercent, 0, minSentenceWords);

		const embedded: EmbeddedChunk[] = [];
		for (const chunk of chunks) {
			const vectors = await model.embedSentences(chunk.sentences.map((sentence) => sentence.text), lane);
			for (let i = chunk.overlap; i < chunk.sentences.length; i++) {
				const data = vectors[i];
				const {start, end} = chunk.sentences[i];
				if (data.length) {
					embedded.push({ embedding: quantizeEmbedding(normalizeEmbedding(data)), start, end });
				}
			}
		}
		return { chunks: embedded, metadata };
	};
}

import { PrepareNoteResult, RelatedNote } from "../types";
import { IndexRepository } from "../ports";
import { maxPairwiseSimilarity, normalizeEmbedding } from "../domain/embedding";
import { EmbedTextUseCase } from "./embedText";
import { PrepareNoteForEmbeddingUseCase } from "./prepareNoteForEmbedding";


export type GetSimilarNotesUseCase = (args: {
	noteId?: string;
	text?: string;
	limit?: number;
	minScore?: number;
}) => Promise<RelatedNote[]>;

export function makeGetSimilarNotes(deps: {
	indexRepo: IndexRepository;
	embedText: EmbedTextUseCase;
	prepareNoteForEmbedding: PrepareNoteForEmbeddingUseCase;
}): GetSimilarNotesUseCase {
	return async function getSimilarNotes(args): Promise<RelatedNote[]> {
		const {
			noteId,
			text,
			limit = 10,
			minScore = 0.25,
		} = args;

		// Prefer using existing embeddings if we have a noteId in the index.
		let queryChunks: number[][] | undefined;

		if (noteId) {
			const existing = await deps.indexRepo.findById(noteId);
			if (existing) queryChunks = existing.chunks.map((chunk) => chunk.embedding);
		}

		// If not found, we need text to compute the query embeddings.
		if (!queryChunks) {
			if (noteId) {
				let prepared: PrepareNoteResult;
				try {
					prepared = await deps.prepareNoteForEmbedding(noteId);
				} catch {
					return [];
				}
				if (prepared.status === "reject") {
					return [];
				}

				const embedded = await deps.embedText(prepared.value.preparedText).catch(() => null);
				if (!embedded?.length) return [];
				queryChunks = embedded.map((chunk) => normalizeEmbedding(chunk.embedding));
			} else {
				if (!text) {
					throw new Error("getRelatedNotes: need either noteId present in index, or text to embed.");
				}
				const embedded = await deps.embedText(text);
				if (!embedded?.length) throw new Error("getRelatedNotes: could not embed text");
				queryChunks = embedded.map((chunk) => normalizeEmbedding(chunk.embedding));
			}
		}

		const finalChunks = queryChunks;
		if (!finalChunks.length) {
			throw new Error("getRelatedNotes: missing query embedding");
		}

		const indexedNotes = await deps.indexRepo.listAll();

		return indexedNotes
			.filter(n => (noteId ? n.id !== noteId : true))
			.map(n => ({
				id: n.id,
				score: maxPairwiseSimilarity(finalChunks, n.chunks.map((chunk) => chunk.embedding)),
			}))
			.filter(r => Number.isFinite(r.score) && r.score >= minScore)
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);
	}
}

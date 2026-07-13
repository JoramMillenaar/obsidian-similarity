import { PrepareNoteResult, RelatedNote } from "../types";
import { IndexRepository } from "../ports";
import { averageEmbeddings, maxCosineSimilarity, normalizeEmbedding } from "../domain/embedding";
import { EmbedTextChunksUseCase } from "./embedText";
import { PrepareNoteForEmbeddingUseCase } from "./prepareNoteForEmbedding";


export type GetSimilarNotesUseCase = (args: {
	noteId?: string;
	text?: string;
	limit?: number;
	minScore?: number;
}) => Promise<RelatedNote[]>;

/** Collapses a note's chunk vectors into a single normalized query vector. */
function toQueryVector(chunkVectors: number[][]): number[] | null {
	const averaged = averageEmbeddings(chunkVectors);
	if (!averaged) return null;
	return normalizeEmbedding(averaged);
}

export function makeGetSimilarNotes(deps: {
	indexRepo: IndexRepository;
	embedTextChunks: EmbedTextChunksUseCase;
	prepareNoteForEmbedding: PrepareNoteForEmbeddingUseCase;
}): GetSimilarNotesUseCase {
	return async function getSimilarNotes(args): Promise<RelatedNote[]> {
		const {
			noteId,
			text,
			limit = 10,
			minScore = 0.25,
		} = args;

		// Prefer reusing the query note's stored chunk vectors if it's indexed.
		let queryEmbedding: number[] | null = null;

		if (noteId) {
			const existing = await deps.indexRepo.findById(noteId);
			if (existing) queryEmbedding = toQueryVector(existing.embeddings);
		}

		if (!queryEmbedding) {
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

				let chunkVectors: number[][] | null;
				try {
					chunkVectors = await deps.embedTextChunks(prepared.value.preparedText);
				} catch {
					return [];
				}
				if (!chunkVectors) return [];
				queryEmbedding = toQueryVector(chunkVectors);
			} else {
				if (!text) {
					throw new Error("getRelatedNotes: need either noteId present in index, or text to embed.");
				}
				const chunkVectors = await deps.embedTextChunks(text);
				if (!chunkVectors) throw new Error("getRelatedNotes: could not embed text");
				queryEmbedding = toQueryVector(chunkVectors);
			}
		}

		const finalEmbedding = queryEmbedding;
		if (!finalEmbedding) {
			throw new Error("getRelatedNotes: missing query embedding");
		}

		const indexedNotes = await deps.indexRepo.listAll();

		return indexedNotes
			.filter(n => (noteId ? n.id !== noteId : true))
			.map(n => ({
				id: n.id,
				score: maxCosineSimilarity(finalEmbedding, n.embeddings),
			}))
			.filter(r => Number.isFinite(r.score) && r.score >= minScore)
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);
	}
}

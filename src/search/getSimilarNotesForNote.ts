import { RelatedNote, SearchMode } from "../types";
import { IndexHandle } from "../indexing/store/indexHandle";

export type GetSimilarNotesForNoteUseCase = (args: {
	noteId: string;
	limit?: number;
	minScore?: number;
	mode?: SearchMode;
}) => Promise<RelatedNote[]>;

export function makeGetSimilarNotesForNote(deps: {
	index: IndexHandle;
}): GetSimilarNotesForNoteUseCase {
	return async function getSimilarNotesForNote({noteId, limit, minScore, mode}): Promise<RelatedNote[]> {
		const existing = deps.index.get(noteId);
		if (!existing) return [];

		const queryChunks = existing.chunks.map((chunk) => chunk.embedding);
		return deps.index.query(queryChunks, {excludeId: noteId, limit, minScore, mode});
	};
}

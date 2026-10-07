import { RelatedNote, SearchMode } from "../types";
import { IndexHandle } from "../indexing/store/indexHandle";

export type SimilarNotesForNote = {
	items: RelatedNote[];
	truncated: boolean;
};

export type GetSimilarNotesForNoteUseCase = (args: {
	noteId: string;
	limit?: number;
	minScore?: number;
	mode?: SearchMode;
}) => Promise<SimilarNotesForNote>;

export function makeGetSimilarNotesForNote(deps: {
	index: IndexHandle;
}): GetSimilarNotesForNoteUseCase {
	return async function getSimilarNotesForNote({noteId, limit, minScore, mode}): Promise<SimilarNotesForNote> {
		const existing = deps.index.get(noteId);
		if (!existing) return {items: [], truncated: false};

		const queryChunks = existing.chunks.map((chunk) => chunk.embedding);
		return {
			items: deps.index.query(queryChunks, {excludeId: noteId, limit, minScore, mode}),
			truncated: existing.truncated === true,
		};
	};
}

import { RelatedNote } from "../types";
import { IndexHandle } from "../indexing/store/indexHandle";

export type SimilarNotesForNote = {
	items: RelatedNote[];
	truncated: boolean;
};

export type GetSimilarNotesForNoteUseCase = (args: {
	noteId: string;
	limit?: number;
	minScore?: number;
}) => Promise<SimilarNotesForNote>;

export function makeGetSimilarNotesForNote(deps: {
	index: IndexHandle;
}): GetSimilarNotesForNoteUseCase {
	return async function getSimilarNotesForNote({noteId, limit, minScore}): Promise<SimilarNotesForNote> {
		const items = deps.index.queryNote(noteId, {limit, minScore});
		if (!items) return {items: [], truncated: false};

		return {items, truncated: deps.index.get(noteId)?.truncated === true};
	};
}

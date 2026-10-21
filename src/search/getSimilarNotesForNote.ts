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
		const items = deps.index.queryNote(noteId, {limit, minScore, mode});
		if (!items) return {items: [], truncated: false};

		return {items, truncated: deps.index.get(noteId)?.truncated === true};
	};
}

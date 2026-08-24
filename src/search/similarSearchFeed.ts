import { RelatedNote } from "../types";
import { GetSimilarNotesForNoteUseCase } from "./getSimilarNotesForNote";
import { GetSimilarNotesForTextUseCase } from "./getSimilarNotesForText";
import { IsIgnoredPath } from "../app/isIgnoredPath";
import { backendNoticeFor, engineNoticeFor, SimilarNotesNotice } from "../status/notices";
import { StatusHub, Unsubscribe } from "../status/statusHub";
import { resolveSimilarNotesForNote } from "./resolveSimilarNotes";

export type SimilarSearchResult = {
	items: RelatedNote[];
	notice?: SimilarNotesNotice;
};

export interface SimilarSearchFeed {
	resolveForNote(noteId: string | null): Promise<SimilarSearchResult>;
	resolveForQuery(text: string): Promise<SimilarSearchResult>;
	subscribeRefreshSignal(fn: () => void): Unsubscribe;
}

type SimilarSearchFeedDeps = {
	statusHub: StatusHub;
	getSimilarNotesForNote: GetSimilarNotesForNoteUseCase;
	getSimilarNotesForText: GetSimilarNotesForTextUseCase;
	isIndexEmpty: () => Promise<boolean>;
	isIgnoredPath: IsIgnoredPath;
};

export function makeSimilarSearchFeed(deps: SimilarSearchFeedDeps): SimilarSearchFeed {
	const backend = deps.statusHub;

	function warmingUp(): SimilarSearchResult {
		return {items: [], notice: engineNoticeFor(backend.getEngineState()) ?? undefined};
	}

	async function resolveEmbeddedQuery(text: string): Promise<SimilarSearchResult> {
		if (!backend.isReady()) {
			return warmingUp();
		}

		const indexEmpty = await deps.isIndexEmpty().catch(() => false);
		if (indexEmpty) {
			return {items: [], notice: backendNoticeFor(true, backend.getIndexingState())};
		}

		const items = await deps.getSimilarNotesForText({text}).catch(() => []);
		return {items, notice: backendNoticeFor(false, backend.getIndexingState())};
	}

	return {
		async resolveForNote(noteId) {
			return resolveSimilarNotesForNote(deps, noteId);
		},

		async resolveForQuery(text) {
			return resolveEmbeddedQuery(text);
		},

		subscribeRefreshSignal(fn) {
			return backend.subscribeRefreshSignal(fn);
		},
	};
}

import { RelatedNote } from "../types";
import { GetSimilarNotesForNoteUseCase } from "./getSimilarNotesForNote";
import { GetSimilarNotesForTextUseCase } from "./getSimilarNotesForText";
import { IsIgnoredPath } from "../app/isIgnoredPath";
import { backendNoticeFor, engineNoticeFor, SimilarNotesNotice } from "../status/notices";
import { StatusHub } from "../status/statusHub";
import { Unsubscribe } from "../core/util/unsubscribe";
import { resolveSimilarNotesForNote } from "./resolveSimilarNotes";

export type SimilarSearchResult = {
	items: RelatedNote[];
	notice?: SimilarNotesNotice;
};

export interface SimilarSearchFeed {
	resolveForNote(noteId: string | null): Promise<SimilarSearchResult>;
	resolveForQuery(text: string): Promise<SimilarSearchResult>;
	/** Starts readying what typed searches need (the keyword index), so the first one isn't slowed down. */
	prepareForQueries(): void;
	subscribeRefreshSignal(fn: () => void): Unsubscribe;
}

type SimilarSearchFeedDeps = {
	statusHub: StatusHub;
	getSimilarNotesForNote: GetSimilarNotesForNoteUseCase;
	getSimilarNotesForText: GetSimilarNotesForTextUseCase;
	prepareKeywordSearch?: () => void;
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

		prepareForQueries() {
			deps.prepareKeywordSearch?.();
		},

		subscribeRefreshSignal(fn) {
			return backend.subscribeRefreshSignal(fn);
		},
	};
}

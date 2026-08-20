import { RelatedNote } from "../types";
import { GetSimilarNotesForNoteUseCase } from "./getSimilarNotesForNote";
import { GetSimilarNotesForTextUseCase } from "./getSimilarNotesForText";
import { IsIgnoredPath } from "./isIgnoredPath";
import { backendNoticeFor, SimilarNotesNotice } from "./similarNotesNotice";
import { BackendState, Unsubscribe } from "./backendState";
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
	backendState: BackendState;
	getSimilarNotesForNote: GetSimilarNotesForNoteUseCase;
	getSimilarNotesForText: GetSimilarNotesForTextUseCase;
	isIndexEmpty: () => Promise<boolean>;
	isIgnoredPath: IsIgnoredPath;
};

export function makeSimilarSearchFeed(deps: SimilarSearchFeedDeps): SimilarSearchFeed {
	const backend = deps.backendState;

	function warmingUp(): SimilarSearchResult {
		const modelState = backend.getModelState();
		if (modelState.status === "error") {
			return {items: [], notice: {kind: "model-error", message: modelState.message, offline: modelState.offline}};
		}
		return {
			items: [],
			notice: {kind: "warming-up", progress: modelState.status === "loading" ? (modelState.progress?.progress ?? null) : null},
		};
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

		subscribeRefreshSignal: backend.subscribeRefreshSignal,
	};
}

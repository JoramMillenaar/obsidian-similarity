import { RelatedNote } from "../types";
import { GetSimilarNotesForNoteUseCase } from "./getSimilarNotesForNote";
import { GetSimilarNotesForTextUseCase } from "./getSimilarNotesForText";
import { IsIgnoredPath } from "./isIgnoredPath";
import { isMarkdownPath } from "../domain/markdownPath";
import { backendNoticeFor, SimilarNotesNotice } from "./similarNotesNotice";
import { BackendState, Unsubscribe } from "./backendState";

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
		return {
			items: [],
			notice: {kind: "warming-up", progress: modelState.status === "loading" ? (modelState.progress?.progress ?? null) : null},
		};
	}

	async function resolveEmbedded(fetchItems: () => Promise<RelatedNote[]>): Promise<SimilarSearchResult> {
		if (!backend.isReady()) {
			return warmingUp();
		}

		const indexEmpty = await deps.isIndexEmpty().catch(() => false);
		if (indexEmpty) {
			return {items: [], notice: backendNoticeFor(true, backend.getIndexingState())};
		}

		const items = await fetchItems().catch(() => []);
		return {items, notice: backendNoticeFor(false, backend.getIndexingState())};
	}

	return {
		async resolveForNote(noteId) {
			if (noteId === null) {
				return {items: [], notice: {kind: "no-active-note"}};
			}
			if (!isMarkdownPath(noteId)) {
				return {items: [], notice: {kind: "unsupported-file"}};
			}
			if (await deps.isIgnoredPath(noteId)) {
				return {items: [], notice: {kind: "ignored-path"}};
			}

			return resolveEmbedded(() => deps.getSimilarNotesForNote({noteId}));
		},

		async resolveForQuery(text) {
			return resolveEmbedded(() => deps.getSimilarNotesForText({text}));
		},

		subscribeRefreshSignal: backend.subscribeRefreshSignal,
	};
}

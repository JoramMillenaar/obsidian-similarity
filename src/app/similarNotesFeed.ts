import { IndexingQueueSnapshot, RelatedNote } from "../types";
import { GetSimilarNotesForNoteUseCase } from "./getSimilarNotesForNote";
import { SubscribeIndexingStateUseCase } from "./indexingProgress";
import { ModelStateReader } from "./modelSession";
import { IsIgnoredPath } from "./isIgnoredPath";
import { isMarkdownPath } from "../domain/markdownPath";
import { backendNoticeFor, SimilarNotesNotice, shouldRefreshOnIndexingChange } from "./similarNotesNotice";

export type { SimilarNotesNotice };

export type SimilarNotesSnapshot = {
	epoch: number;
	noteId: string | null;
	items: RelatedNote[];
	refining: boolean;
	notice?: SimilarNotesNotice;
};

export type Unsubscribe = () => void;

export interface SimilarNotesFeed {
	getSnapshot(): SimilarNotesSnapshot;
	subscribe(fn: (snapshot: SimilarNotesSnapshot) => void): Unsubscribe;
	setActiveNote(noteId: string | null): void;
	retryIndexing(): Promise<void>;
	refresh(): void;
	dispose(): void;
}

type SimilarNotesFeedDeps = {
	modelSession: ModelStateReader;
	subscribeIndexingState: SubscribeIndexingStateUseCase;
	getSimilarNotesForNote: GetSimilarNotesForNoteUseCase;
	isIndexEmpty: () => Promise<boolean>;
	isIgnoredPath: IsIgnoredPath;
	synchronizeIndex: () => Promise<void>;
	refreshDebounceMs?: number;
};

const IDLE: SimilarNotesSnapshot = {epoch: 0, noteId: null, items: [], refining: false, notice: {kind: "no-active-note"}};

export function makeSimilarNotesFeed(deps: SimilarNotesFeedDeps): SimilarNotesFeed {
	const refreshDebounceMs = deps.refreshDebounceMs ?? 1500;

	let epoch = 0;
	let noteId: string | null = null;
	let snapshot: SimilarNotesSnapshot = IDLE;
	let indexingState: IndexingQueueSnapshot | undefined;
	let modelReady = deps.modelSession.getSnapshot().status === "ready";
	let lastIndexEmpty = false;
	let lastRefreshAt = 0;
	let refreshTimer: ReturnType<typeof setTimeout> | undefined;
	const listeners = new Set<(snapshot: SimilarNotesSnapshot) => void>();

	function emit(next: SimilarNotesSnapshot) {
		snapshot = next;
		for (const listener of listeners) listener(snapshot);
	}

	async function load(forEpoch: number) {
		if (forEpoch !== epoch || noteId === null) return;
		const currentNoteId = noteId;

		if (!isMarkdownPath(currentNoteId)) {
			emit({epoch: forEpoch, noteId: currentNoteId, items: [], refining: false, notice: {kind: "unsupported-file"}});
			return;
		}

		if (await deps.isIgnoredPath(currentNoteId)) {
			if (forEpoch !== epoch) return;
			emit({epoch: forEpoch, noteId: currentNoteId, items: [], refining: false, notice: {kind: "ignored-path"}});
			return;
		}
		if (forEpoch !== epoch) return;

		const modelState = deps.modelSession.getSnapshot();
		const ready = modelState.status === "ready";

		const items = await deps.getSimilarNotesForNote({noteId: currentNoteId}).catch(() => []);
		if (forEpoch !== epoch) return;

		if (!ready) {
			emit({
				epoch: forEpoch,
				noteId: currentNoteId,
				items,
				refining: true,
				notice: {kind: "warming-up", progress: modelState.status === "loading" ? (modelState.progress?.progress ?? null) : null},
			});
			return;
		}

		const indexEmpty = await deps.isIndexEmpty().catch(() => false);
		if (forEpoch !== epoch) return;
		lastIndexEmpty = indexEmpty;

		emit({
			epoch: forEpoch,
			noteId: currentNoteId,
			items,
			refining: false,
			notice: backendNoticeFor(indexEmpty, indexingState),
		});
	}

	function scheduleRefresh() {
		if (refreshTimer || noteId === null) return;
		const elapsed = Date.now() - lastRefreshAt;
		const delay = Math.max(0, refreshDebounceMs - elapsed);
		refreshTimer = setTimeout(() => {
			refreshTimer = undefined;
			lastRefreshAt = Date.now();
			void load(epoch);
		}, delay);
	}

	const BACKEND_NOTICE_KINDS = new Set(["indexing", "empty-index", "fatal-error", undefined]);

	const unsubscribeIndexingState = deps.subscribeIndexingState((next) => {
		const previous = indexingState;
		indexingState = next;
		if (shouldRefreshOnIndexingChange(previous, next, noteId)) {
			scheduleRefresh();
		} else if (snapshot.noteId !== null && !snapshot.refining && BACKEND_NOTICE_KINDS.has(snapshot.notice?.kind)) {
			emit({...snapshot, notice: backendNoticeFor(lastIndexEmpty, next)});
		}
	});

	const unsubscribeModelState = deps.modelSession.subscribe((next) => {
		const wasReady = modelReady;
		modelReady = next.status === "ready";

		if (modelReady && !wasReady && noteId !== null) {
			epoch += 1;
			void load(epoch);
		} else if (next.status === "loading" && snapshot.notice?.kind === "warming-up") {
			emit({...snapshot, notice: {kind: "warming-up", progress: next.progress?.progress ?? null}});
		}
	});

	return {
		getSnapshot: () => snapshot,
		subscribe(fn) {
			listeners.add(fn);
			fn(snapshot);
			return () => listeners.delete(fn);
		},
		setActiveNote(next) {
			if (next === noteId) return;
			noteId = next;
			epoch += 1;
			if (refreshTimer) {
				clearTimeout(refreshTimer);
				refreshTimer = undefined;
			}
			if (next === null) {
				emit({epoch, noteId: null, items: [], refining: false, notice: {kind: "no-active-note"}});
				return;
			}
			void load(epoch);
		},
		async retryIndexing() {
			await deps.synchronizeIndex();
		},
		refresh() {
			if (noteId === null) return;
			epoch += 1;
			void load(epoch);
		},
		dispose() {
			unsubscribeIndexingState();
			unsubscribeModelState();
			if (refreshTimer) clearTimeout(refreshTimer);
			listeners.clear();
		},
	};
}

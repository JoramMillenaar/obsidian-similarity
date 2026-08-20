import { IndexingQueueSnapshot, RelatedNote } from "../types";
import { GetSimilarNotesForNoteUseCase } from "./getSimilarNotesForNote";
import { IsIgnoredPath } from "./isIgnoredPath";
import { backendNoticeFor, SimilarNotesNotice, shouldRefreshOnIndexingChange } from "./similarNotesNotice";
import { BackendState } from "./backendState";
import { resolveSimilarNotesForNote } from "./resolveSimilarNotes";

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
	backendState: BackendState;
	getSimilarNotesForNote: GetSimilarNotesForNoteUseCase;
	isIndexEmpty: () => Promise<boolean>;
	isIgnoredPath: IsIgnoredPath;
	synchronizeIndex: () => Promise<void>;
	refreshDebounceMs?: number;
};

const IDLE: SimilarNotesSnapshot = {epoch: 0, noteId: null, items: [], refining: false, notice: {kind: "no-active-note"}};

export function makeSimilarNotesFeed(deps: SimilarNotesFeedDeps): SimilarNotesFeed {
	const backend = deps.backendState;
	const refreshDebounceMs = deps.refreshDebounceMs ?? 1500;

	let epoch = 0;
	let noteId: string | null = null;
	let snapshot: SimilarNotesSnapshot = IDLE;
	let indexingState: IndexingQueueSnapshot | undefined = backend.getIndexingState();
	let modelReady = backend.getModelState().status === "ready";
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

		const result = await resolveSimilarNotesForNote(
			{
				backendState: backend,
				getSimilarNotesForNote: deps.getSimilarNotesForNote,
				isIndexEmpty: deps.isIndexEmpty,
				isIgnoredPath: deps.isIgnoredPath,
			},
			currentNoteId,
		);
		if (forEpoch !== epoch) return;

		if (result.indexEmpty !== undefined) lastIndexEmpty = result.indexEmpty;

		emit({
			epoch: forEpoch,
			noteId: currentNoteId,
			items: result.items,
			refining: result.notice?.kind === "warming-up",
			notice: result.notice,
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

	const unsubscribeIndexingState = backend.subscribeIndexingState((next) => {
		const previous = indexingState;
		indexingState = next;
		if (shouldRefreshOnIndexingChange(previous, next, noteId)) {
			scheduleRefresh();
		} else if (snapshot.noteId !== null && !snapshot.refining && BACKEND_NOTICE_KINDS.has(snapshot.notice?.kind)) {
			emit({...snapshot, notice: backendNoticeFor(lastIndexEmpty, next)});
		}
	});

	const unsubscribeModelState = backend.subscribeModelState((next) => {
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

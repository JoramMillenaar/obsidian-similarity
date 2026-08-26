import { IndexingQueueSnapshot } from "../types";
import { EmbeddingEngine, EngineStatus } from "../embedding/engine";
import { Indexer } from "../indexing/indexer";
import { shouldRefreshOnIndexingChange } from "./notices";

export type Unsubscribe = () => void;

export interface StatusHub {
	getIndexingState(): IndexingQueueSnapshot | undefined;

	getEngineState(): EngineStatus;

	isReady(): boolean;

	subscribeEngineState(fn: (status: EngineStatus) => void): Unsubscribe;

	subscribeIndexingState(fn: (snapshot: IndexingQueueSnapshot) => void): Unsubscribe;

	subscribeRefreshSignal(fn: () => void): Unsubscribe;

	dispose(): void;
}

type StatusHubDeps = {
	engine: EmbeddingEngine;
	indexer: Indexer;
	refreshThrottleMs?: number;
};

export function makeStatusHub(deps: StatusHubDeps): StatusHub {
	const refreshThrottleMs = deps.refreshThrottleMs ?? 1500;

	let indexingState: IndexingQueueSnapshot | undefined;
	let ready = deps.engine.status().kind === "ready";
	let lastRefreshAt = 0;
	let refreshTimer: number | undefined;
	const refreshListeners = new Set<() => void>();
	const engineListeners = new Set<(status: EngineStatus) => void>();
	const indexingListeners = new Set<(snapshot: IndexingQueueSnapshot) => void>();

	function emitRefresh() {
		for (const fn of refreshListeners) fn();
	}

	function scheduleThrottledRefresh() {
		if (refreshTimer) return;
		const elapsed = Date.now() - lastRefreshAt;
		const delay = Math.max(0, refreshThrottleMs - elapsed);
		refreshTimer = window.setTimeout(() => {
			refreshTimer = undefined;
			lastRefreshAt = Date.now();
			emitRefresh();
		}, delay);
	}

	const unsubscribeIndexing = deps.indexer.subscribe((next) => {
		const previous = indexingState;
		indexingState = next;
		for (const fn of indexingListeners) fn(next);
		if (shouldRefreshOnIndexingChange(previous, next, null)) {
			scheduleThrottledRefresh();
		}
	});

	const unsubscribeEngine = deps.engine.subscribe((next) => {
		const wasReady = ready;
		ready = next.kind === "ready";
		for (const fn of engineListeners) fn(next);
		if (ready && !wasReady) {
			if (refreshTimer) {
				window.clearTimeout(refreshTimer);
				refreshTimer = undefined;
			}
			lastRefreshAt = Date.now();
			emitRefresh();
		}
	});

	return {
		getIndexingState: () => indexingState,
		getEngineState: () => deps.engine.status(),
		isReady: () => ready,
		subscribeEngineState(fn) {
			engineListeners.add(fn);
			fn(deps.engine.status());
			return () => engineListeners.delete(fn);
		},
		subscribeIndexingState(fn) {
			indexingListeners.add(fn);
			if (indexingState) fn(indexingState);
			return () => indexingListeners.delete(fn);
		},
		subscribeRefreshSignal(fn) {
			refreshListeners.add(fn);
			return () => refreshListeners.delete(fn);
		},
		dispose() {
			unsubscribeIndexing();
			unsubscribeEngine();
			if (refreshTimer) window.clearTimeout(refreshTimer);
			refreshListeners.clear();
			engineListeners.clear();
			indexingListeners.clear();
		},
	};
}

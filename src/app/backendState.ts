import { IndexingQueueSnapshot } from "../types";
import { ModelSessionSnapshot, ModelStateReader } from "./modelSession";
import { SubscribeIndexingStateUseCase } from "./indexingProgress";
import { shouldRefreshOnIndexingChange } from "./similarNotesNotice";

export type Unsubscribe = () => void;

export interface BackendState {
	getIndexingState(): IndexingQueueSnapshot | undefined;
	getModelState(): ModelSessionSnapshot;
	isReady(): boolean;
	subscribeModelState(fn: (snapshot: ModelSessionSnapshot) => void): Unsubscribe;
	subscribeIndexingState(fn: (snapshot: IndexingQueueSnapshot) => void): Unsubscribe;
	subscribeRefreshSignal(fn: () => void): Unsubscribe;
	dispose(): void;
}

type BackendStateDeps = {
	modelSession: ModelStateReader;
	subscribeIndexingState: SubscribeIndexingStateUseCase;
	refreshThrottleMs?: number;
};

export function makeBackendState(deps: BackendStateDeps): BackendState {
	const refreshThrottleMs = deps.refreshThrottleMs ?? 1500;

	let indexingState: IndexingQueueSnapshot | undefined;
	let modelReady = deps.modelSession.getSnapshot().status === "ready";
	let lastRefreshAt = 0;
	let refreshTimer: ReturnType<typeof setTimeout> | undefined;
	const refreshListeners = new Set<() => void>();
	const modelStateListeners = new Set<(snapshot: ModelSessionSnapshot) => void>();
	const indexingStateListeners = new Set<(snapshot: IndexingQueueSnapshot) => void>();

	function emitRefresh() {
		for (const fn of refreshListeners) fn();
	}

	function scheduleThrottledRefresh() {
		if (refreshTimer) return;
		const elapsed = Date.now() - lastRefreshAt;
		const delay = Math.max(0, refreshThrottleMs - elapsed);
		refreshTimer = setTimeout(() => {
			refreshTimer = undefined;
			lastRefreshAt = Date.now();
			emitRefresh();
		}, delay);
	}

	const unsubscribeIndexingState = deps.subscribeIndexingState((next) => {
		const previous = indexingState;
		indexingState = next;
		for (const fn of indexingStateListeners) fn(next);
		if (shouldRefreshOnIndexingChange(previous, next, null)) {
			scheduleThrottledRefresh();
		}
	});

	const unsubscribeModelState = deps.modelSession.subscribe((next) => {
		const wasReady = modelReady;
		modelReady = next.status === "ready";
		for (const fn of modelStateListeners) fn(next);
		if (modelReady && !wasReady) {
			if (refreshTimer) {
				clearTimeout(refreshTimer);
				refreshTimer = undefined;
			}
			lastRefreshAt = Date.now();
			emitRefresh();
		}
	});

	return {
		getIndexingState: () => indexingState,
		getModelState: () => deps.modelSession.getSnapshot(),
		isReady: () => modelReady,
		subscribeModelState(fn) {
			modelStateListeners.add(fn);
			fn(deps.modelSession.getSnapshot());
			return () => modelStateListeners.delete(fn);
		},
		subscribeIndexingState(fn) {
			indexingStateListeners.add(fn);
			if (indexingState) fn(indexingState);
			return () => indexingStateListeners.delete(fn);
		},
		subscribeRefreshSignal(fn) {
			refreshListeners.add(fn);
			return () => refreshListeners.delete(fn);
		},
		dispose() {
			unsubscribeIndexingState();
			unsubscribeModelState();
			if (refreshTimer) clearTimeout(refreshTimer);
			refreshListeners.clear();
			modelStateListeners.clear();
			indexingStateListeners.clear();
		},
	};
}

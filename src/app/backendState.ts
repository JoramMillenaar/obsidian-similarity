import { IndexingQueueSnapshot } from "../types";
import { ModelSessionSnapshot, ModelStateReader } from "./modelSession";
import { SubscribeIndexingStateUseCase } from "./indexingProgress";
import { BannerState, computeBanner } from "./backendBanner";
import { shouldRefreshOnIndexingChange } from "./similarNotesNotice";

export type Unsubscribe = () => void;

export interface BackendState {
	getIndexingState(): IndexingQueueSnapshot | undefined;
	getModelSnapshot(): ModelSessionSnapshot;
	isReady(): boolean;
	subscribeBanner(fn: (banner: BannerState) => void): Unsubscribe;
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
	const bannerListeners = new Set<(banner: BannerState) => void>();
	const refreshListeners = new Set<() => void>();

	function emitBanner() {
		if (!indexingState) return;
		const banner = computeBanner(deps.modelSession.getSnapshot(), indexingState);
		for (const fn of bannerListeners) fn(banner);
	}

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
		emitBanner();
		if (shouldRefreshOnIndexingChange(previous, next, null)) {
			scheduleThrottledRefresh();
		}
	});

	const unsubscribeModelState = deps.modelSession.subscribe((next) => {
		const wasReady = modelReady;
		modelReady = next.status === "ready";
		emitBanner();
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
		getModelSnapshot: () => deps.modelSession.getSnapshot(),
		isReady: () => modelReady,
		subscribeBanner(fn) {
			bannerListeners.add(fn);
			if (indexingState) fn(computeBanner(deps.modelSession.getSnapshot(), indexingState));
			return () => bannerListeners.delete(fn);
		},
		subscribeRefreshSignal(fn) {
			refreshListeners.add(fn);
			return () => refreshListeners.delete(fn);
		},
		dispose() {
			unsubscribeIndexingState();
			unsubscribeModelState();
			if (refreshTimer) clearTimeout(refreshTimer);
			bannerListeners.clear();
			refreshListeners.clear();
		},
	};
}

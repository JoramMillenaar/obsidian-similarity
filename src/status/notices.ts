import { IndexingQueueSnapshot } from "../types";
import { EngineStatus } from "../embedding/engine";

/**
 * Everything the user can be told about why results are (or are not) showing.
 *
 * Derived in one place. When several components each combined model state and
 * indexing state themselves, they drifted: the sidebar, the search modal and the
 * banner disagreed about when the plugin was "busy".
 */
export type SimilarNotesNotice =
	| { kind: "no-active-note" }
	| { kind: "unsupported-file" }
	| { kind: "ignored-path" }
	| { kind: "warming-up"; progress: number | null }
	| { kind: "model-error"; message: string; offline: boolean }
	| { kind: "indexing"; processed: number; total: number; indexEmpty: boolean }
	| { kind: "empty-index" }
	| { kind: "fatal-error"; message: string; indexEmpty: boolean };

export type BannerState = {
	visible: boolean;
	message: string;
	processed: number;
	total: number;
};

const MIN_ITEMS_FOR_INDEXING_BANNER = 8;
const HIDDEN_BANNER: BannerState = {visible: false, message: "", processed: 0, total: 0};

/** The notice for a note we can serve — model and index state only, nothing per-note. */
export function backendNoticeFor(
	indexEmpty: boolean,
	indexing: IndexingQueueSnapshot | undefined,
): SimilarNotesNotice | undefined {
	if (indexing?.fatalError) {
		return {kind: "fatal-error", message: indexing.fatalError, indexEmpty};
	}
	if (indexing && (indexing.isRunning || indexing.pending > 0)) {
		return {kind: "indexing", processed: indexing.processed, total: indexing.total, indexEmpty};
	}
	if (indexEmpty) {
		return {kind: "empty-index"};
	}
	return undefined;
}

/** The notice for a model that cannot serve anything yet. */
export function engineNoticeFor(engine: EngineStatus): SimilarNotesNotice | null {
	if (engine.kind === "error") {
		return {kind: "model-error", message: engine.message, offline: engine.offline};
	}
	if (engine.kind !== "ready") {
		return {kind: "warming-up", progress: engine.kind === "loading" ? engine.progress : null};
	}
	return null;
}

export function shouldRefreshOnIndexingChange(
	previous: IndexingQueueSnapshot | undefined,
	next: IndexingQueueSnapshot,
	currentNoteId: string | null,
): boolean {
	if (!previous) return false;
	if (previous.fatalError !== next.fatalError) return true;
	if (previous.isRunning && !next.isRunning) return true;
	if (currentNoteId !== null && previous.currentNoteId === currentNoteId && next.currentNoteId !== currentNoteId) return true;
	if (previous.processed !== next.processed) return true;
	return false;
}

function modelDownloadBanner(engine: EngineStatus): BannerState {
	if (engine.kind !== "loading" || engine.progress === null || engine.progress >= 100) {
		return HIDDEN_BANNER;
	}

	return {
		visible: true,
		message: "Setting up...",
		processed: Math.round(engine.progress),
		total: 100,
	};
}

function indexingBanner(indexing: IndexingQueueSnapshot): BannerState {
	const hidden = {...HIDDEN_BANNER, processed: indexing.processed, total: indexing.total};
	if (indexing.fatalError || !(indexing.isRunning || indexing.pending > 0)) return hidden;
	if (indexing.total <= MIN_ITEMS_FOR_INDEXING_BANNER - 1) return hidden;

	return {
		visible: true,
		message: "Optimizing your experience. Results may shift as more notes are processed.",
		processed: indexing.processed,
		total: indexing.total,
	};
}

export function computeBanner(engine: EngineStatus, indexing: IndexingQueueSnapshot): BannerState {
	const download = modelDownloadBanner(engine);
	return download.visible ? download : indexingBanner(indexing);
}

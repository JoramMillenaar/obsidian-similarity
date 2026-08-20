import { IndexingQueueSnapshot } from "../types";

export type SimilarNotesNotice =
	| { kind: "no-active-note" }
	| { kind: "unsupported-file" }
	| { kind: "ignored-path" }
	| { kind: "warming-up"; progress: number | null }
	| { kind: "indexing"; processed: number; total: number; indexEmpty: boolean }
	| { kind: "empty-index" }
	| { kind: "fatal-error"; message: string; indexEmpty: boolean };

export function backendNoticeFor(indexEmpty: boolean, indexing: IndexingQueueSnapshot | undefined): SimilarNotesNotice | undefined {
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

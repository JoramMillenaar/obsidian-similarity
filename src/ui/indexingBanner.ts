import { IndexingQueueSnapshot } from "../types";

export type IndexingBannerState = {
	kind: "hidden" | "initial" | "updating" | "failed";
	message: string;
	progressLabel?: string;
	processed: number;
	total: number;
};

export function getIndexingBannerState(snapshot: IndexingQueueSnapshot): IndexingBannerState {
	const {processed, total} = snapshot;
	const progressLabel = total > 0
		? `${processed} / ${total}`
		: undefined;

	if (snapshot.fatalError) {
		return {
			kind: "failed",
			message: snapshot.hasCompletedInitialIndex
				? "Index updates paused after an error. Results may be stale until you sync again."
				: "Indexing paused after an error. Results may be incomplete until you sync again.",
			progressLabel,
			processed,
			total,
		};
	}

	if (snapshot.isRunning || snapshot.pending > 0) {
		return {
			kind: snapshot.hasCompletedInitialIndex ? "updating" : "initial",
			message: snapshot.hasCompletedInitialIndex
				? "Index update in progress. Results may shift as more notes are processed."
				: "Initial indexing in progress. Results are already available, but they may still be incomplete.",
			progressLabel,
			processed,
			total,
		};
	}

	return {
		kind: "hidden",
		message: "",
		progressLabel,
		processed,
		total,
	};
}

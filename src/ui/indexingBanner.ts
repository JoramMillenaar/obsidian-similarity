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
			message: "Indexing paused after an error. Try restarting your Obsidian.",
			progressLabel,
			processed,
			total,
		};
	}

	if (snapshot.isRunning || snapshot.pending > 0) {
		return {
			kind: "updating",
			message: "Optimizing your experience. Results may shift as more notes are processed.",
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

import { IndexingQueueSnapshot } from "../types";
import { ModelSessionSnapshot } from "../app/modelSession";

export type BannerState = {
	visible: boolean;
	message: string;
	processed: number;
	total: number;
};

const HIDDEN_BANNER: BannerState = {visible: false, message: "", processed: 0, total: 0};

export function getModelDownloadBannerState(snapshot: ModelSessionSnapshot): BannerState {
	if (snapshot.status !== "loading" || !snapshot.progress || snapshot.progress.progress >= 100) {
		return HIDDEN_BANNER;
	}

	return {
		visible: true,
		message: "Setting up your experience.",
		processed: Math.round(snapshot.progress.progress),
		total: 100,
	};
}

export function getIndexingBannerState(snapshot: IndexingQueueSnapshot): BannerState {
	if (snapshot.fatalError || !(snapshot.isRunning || snapshot.pending > 0)) {
		return {...HIDDEN_BANNER, processed: snapshot.processed, total: snapshot.total};
	}

	return {
		visible: true,
		message: "Optimizing your experience. Results may shift as more notes are processed.",
		processed: snapshot.processed,
		total: snapshot.total,
	};
}

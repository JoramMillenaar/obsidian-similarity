import { IndexingQueueSnapshot } from "../types";
import { ModelSessionSnapshot } from "./modelSession";

export type BannerState = {
	visible: boolean;
	message: string;
	processed: number;
	total: number;
};

const MIN_ITEMS_FOR_INDEXING_BANNER = 8;
const HIDDEN_BANNER: BannerState = {visible: false, message: "", processed: 0, total: 0};

function modelDownloadBanner(snapshot: ModelSessionSnapshot): BannerState {
	if (snapshot.status !== "loading" || !snapshot.progress || snapshot.progress.progress >= 100) {
		return HIDDEN_BANNER;
	}

	return {
		visible: true,
		message: "Setting up...",
		processed: Math.round(snapshot.progress.progress),
		total: 100,
	};
}

function indexingBanner(snapshot: IndexingQueueSnapshot): BannerState {
	const hidden = {...HIDDEN_BANNER, processed: snapshot.processed, total: snapshot.total};
	if (snapshot.fatalError || !(snapshot.isRunning || snapshot.pending > 0)) return hidden;
	if (snapshot.total <= MIN_ITEMS_FOR_INDEXING_BANNER - 1) return hidden;

	return {
		visible: true,
		message: "Optimizing your experience. Results may shift as more notes are processed.",
		processed: snapshot.processed,
		total: snapshot.total,
	};
}

export function computeBanner(modelState: ModelSessionSnapshot, indexingState: IndexingQueueSnapshot): BannerState {
	const download = modelDownloadBanner(modelState);
	return download.visible ? download : indexingBanner(indexingState);
}

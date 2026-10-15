import { BannerState, computeBanner } from "../status/notices";
import { StatusHub } from "../status/statusHub";
import { Unsubscribe } from "../core/util/unsubscribe";
import { INDEXING_FINISHING_MESSAGE, IndexingMessages, isNearlyDone, titleFromNoteId } from "../status/indexingMessages";
import { IndexingQueueSnapshot } from "../types";

export type { BannerState };
export { computeBanner };

const BANNER_THROTTLE_MS = 120;
const MESSAGE_ROTATE_MS = 9000;
const RECENT_TITLES = 8;

type Rotation = {
	messages: IndexingMessages;
	message: string;
	recentTitles: string[];
	finishing: boolean;
	timer: number;
};

export function subscribeBanner(
	statusHub: StatusHub,
	fn: (banner: BannerState) => void,
	throttleMs = BANNER_THROTTLE_MS,
): Unsubscribe {
	let lastEmitAt = 0;
	let timer: number | undefined;
	let rotation: Rotation | undefined;

	function stopRotation() {
		if (rotation) window.clearTimeout(rotation.timer);
		rotation = undefined;
	}

	function scheduleRotation() {
		if (!rotation) return;
		rotation.timer = window.setTimeout(() => {
			if (!rotation) return;
			if (rotation.finishing) return;
			rotation.message = rotation.messages.next({recentTitles: rotation.recentTitles});
			scheduleRotation();
			flush();
		}, MESSAGE_ROTATE_MS);
	}

	function withRotatingMessage(banner: BannerState, indexing: IndexingQueueSnapshot): BannerState {
		if (!banner.visible || !banner.rotating) {
			stopRotation();
			return banner;
		}
		if (!rotation) {
			const messages = new IndexingMessages();
			rotation = {
				messages,
				message: messages.next({recentTitles: []}),
				recentTitles: [],
				finishing: false,
				timer: 0,
			};
			scheduleRotation();
		}
		if (!rotation.finishing && isNearlyDone(indexing.processed, indexing.total)) {
			rotation.finishing = true;
			rotation.message = INDEXING_FINISHING_MESSAGE;
		}
		const title = titleFromNoteId(indexing.currentNoteId);
		const titles = rotation.recentTitles;
		if (title && titles[titles.length - 1] !== title) {
			titles.push(title);
			if (titles.length > RECENT_TITLES) titles.shift();
		}
		return {...banner, message: rotation.message};
	}

	function flush() {
		timer = undefined;
		const indexing = statusHub.getIndexingState();
		if (!indexing) return;
		lastEmitAt = Date.now();
		fn(withRotatingMessage(computeBanner(statusHub.getEngineState(), indexing), indexing));
	}

	function emit() {
		if (timer != null) return;
		const wait = throttleMs - (Date.now() - lastEmitAt);
		if (wait <= 0) flush();
		else timer = window.setTimeout(flush, wait);
	}

	const unsubscribeEngine = statusHub.subscribeEngineState(() => emit());
	const unsubscribeIndexing = statusHub.subscribeIndexingState(() => emit());

	return () => {
		if (timer != null) window.clearTimeout(timer);
		stopRotation();
		unsubscribeEngine();
		unsubscribeIndexing();
	};
}

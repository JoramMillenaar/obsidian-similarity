/** Banner state over time: what to say and when (rotation, done hold, throttling). No DOM. */
import { BannerState, computeBanner, indexingDoneBanner } from "../status/notices";
import { StatusHub } from "../status/statusHub";
import { Unsubscribe } from "../core/util/unsubscribe";
import { INDEXING_FINISHING_MESSAGE, IndexingMessages, isNearlyDone, titleFromNoteId } from "../status/indexingMessages";
import { IndexingQueueSnapshot } from "../types";

export type { BannerState };
export { computeBanner };

const BANNER_THROTTLE_MS = 120;
const MESSAGE_ROTATE_MS = 9000;
const DONE_HOLD_MS = 5000;
const RECENT_TITLES = 8;

type Rotation = {
	messages: IndexingMessages;
	message: string;
	recentTitles: string[];
	finishing: boolean;
	total: number;
	timer: number;
};

export function subscribeBanner(
	statusHub: StatusHub,
	fn: (banner: BannerState) => void,
	throttleMs = BANNER_THROTTLE_MS,
): Unsubscribe {
	let lastEmitAt = 0;
	let throttleTimer: number | undefined;
	let rotation: Rotation | undefined;
	let done: { banner: BannerState; timer: number } | undefined;

	function stopRotation() {
		if (rotation) window.clearTimeout(rotation.timer);
		rotation = undefined;
	}

	function clearDone() {
		if (done) window.clearTimeout(done.timer);
		done = undefined;
	}

	function scheduleRotation(r: Rotation) {
		r.timer = window.setTimeout(() => {
			if (rotation !== r || r.finishing) return;
			r.message = r.messages.next({recentTitles: r.recentTitles});
			scheduleRotation(r);
			flush();
		}, MESSAGE_ROTATE_MS);
	}

	function startRotation(): Rotation {
		const messages = new IndexingMessages();
		const r: Rotation = {
			messages,
			message: messages.next({recentTitles: []}),
			recentTitles: [],
			finishing: false,
			total: 0,
			timer: 0,
		};
		scheduleRotation(r);
		return r;
	}

	function withRotatingMessage(banner: BannerState, indexing: IndexingQueueSnapshot): BannerState {
		const r = rotation ??= startRotation();
		r.total = indexing.total;
		if (!r.finishing && isNearlyDone(indexing.processed, indexing.total)) {
			r.finishing = true;
			r.message = INDEXING_FINISHING_MESSAGE;
		}
		const title = titleFromNoteId(indexing.currentNoteId);
		if (title && r.recentTitles[r.recentTitles.length - 1] !== title) {
			r.recentTitles.push(title);
			if (r.recentTitles.length > RECENT_TITLES) r.recentTitles.shift();
		}
		return {...banner, message: r.message};
	}

	function resolve(indexing: IndexingQueueSnapshot): BannerState {
		const banner = computeBanner(statusHub.getEngineState(), indexing);
		if (banner.visible) {
			clearDone();
			if (banner.rotating) return withRotatingMessage(banner, indexing);
			stopRotation();
			return banner;
		}

		const finished = rotation && !indexing.fatalError ? rotation.total : undefined;
		stopRotation();
		if (finished !== undefined) {
			clearDone();
			done = {
				banner: indexingDoneBanner(finished),
				timer: window.setTimeout(() => {
					done = undefined;
					flush();
				}, DONE_HOLD_MS),
			};
		}
		return done?.banner ?? banner;
	}

	function flush() {
		throttleTimer = undefined;
		const indexing = statusHub.getIndexingState();
		if (!indexing) return;
		lastEmitAt = Date.now();
		fn(resolve(indexing));
	}

	function emit() {
		if (throttleTimer != null) return;
		const wait = throttleMs - (Date.now() - lastEmitAt);
		if (wait <= 0) flush();
		else throttleTimer = window.setTimeout(flush, wait);
	}

	const unsubscribeEngine = statusHub.subscribeEngineState(() => emit());
	const unsubscribeIndexing = statusHub.subscribeIndexingState(() => emit());

	return () => {
		if (throttleTimer != null) window.clearTimeout(throttleTimer);
		stopRotation();
		clearDone();
		unsubscribeEngine();
		unsubscribeIndexing();
	};
}

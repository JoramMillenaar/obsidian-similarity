import { BannerState, computeBanner } from "../status/notices";
import { StatusHub } from "../status/statusHub";
import { Unsubscribe } from "../core/util/unsubscribe";

export type { BannerState };
export { computeBanner };

const BANNER_THROTTLE_MS = 120;

export function subscribeBanner(statusHub: StatusHub, fn: (banner: BannerState) => void): Unsubscribe {
	let lastEmitAt = 0;
	let timer: number | undefined;

	function flush() {
		timer = undefined;
		const indexing = statusHub.getIndexingState();
		if (!indexing) return;
		lastEmitAt = Date.now();
		fn(computeBanner(statusHub.getEngineState(), indexing));
	}

	function emit() {
		if (timer != null) return;
		const wait = BANNER_THROTTLE_MS - (Date.now() - lastEmitAt);
		if (wait <= 0) flush();
		else timer = window.setTimeout(flush, wait);
	}

	const unsubscribeEngine = statusHub.subscribeEngineState(() => emit());
	const unsubscribeIndexing = statusHub.subscribeIndexingState(() => emit());

	return () => {
		if (timer != null) window.clearTimeout(timer);
		unsubscribeEngine();
		unsubscribeIndexing();
	};
}

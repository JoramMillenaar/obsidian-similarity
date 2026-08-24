import { BannerState, computeBanner } from "../status/notices";
import { StatusHub, Unsubscribe } from "../status/statusHub";

export type { BannerState };
export { computeBanner };

export function subscribeBanner(statusHub: StatusHub, fn: (banner: BannerState) => void): Unsubscribe {
	function emit() {
		const indexing = statusHub.getIndexingState();
		if (!indexing) return;
		fn(computeBanner(statusHub.getEngineState(), indexing));
	}

	const unsubscribeEngine = statusHub.subscribeEngineState(() => emit());
	const unsubscribeIndexing = statusHub.subscribeIndexingState(() => emit());

	return () => {
		unsubscribeEngine();
		unsubscribeIndexing();
	};
}

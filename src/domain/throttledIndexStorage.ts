import { IndexedNote } from "../types";
import { IndexStorage } from "../ports";

/**
 * Wraps an IndexStorage so that rapid rewrite() calls coalesce into at most
 * one underlying disk write per intervalMs. Throttles rather than debounces:
 * a pending timer is not reset by later calls, so continuous writes still
 * flush at a steady cadence instead of being starved indefinitely.
 *
 * getAll()/isEmpty() serve the latest unflushed index from memory so callers
 * never observe stale data during the throttle window.
 */
export class ThrottledIndexStorage implements IndexStorage {
	private pending: IndexedNote[] | null = null;
	private timer: number | null = null;
	private flushing: Promise<void> = Promise.resolve();

	constructor(
		private readonly underlying: IndexStorage,
		private readonly intervalMs: number,
	) {
	}

	async getAll(): Promise<IndexedNote[]> {
		if (this.pending != null) return this.pending;
		return await this.underlying.getAll();
	}

	async rewrite(index: IndexedNote[]): Promise<void> {
		this.pending = index;
		this.scheduleFlush();
	}

	async isEmpty(): Promise<boolean> {
		if (this.pending != null) return this.pending.length === 0;
		return await this.underlying.isEmpty();
	}

	async needsRebuild(): Promise<boolean> {
		return await this.underlying.needsRebuild();
	}

	async readLegacy(): Promise<IndexedNote[] | null> {
		return await this.underlying.readLegacy();
	}

	async flush(): Promise<void> {
		if (this.timer != null) {
			window.clearTimeout(this.timer);
			this.timer = null;
		}
		await this.runFlush();
	}

	private scheduleFlush(): void {
		if (this.timer != null) return;

		this.timer = window.setTimeout(() => {
			this.timer = null;
			void this.runFlush();
		}, this.intervalMs);
	}

	private runFlush(): Promise<void> {
		this.flushing = this.flushing.then(async () => {
			const snapshot = this.pending;
			if (snapshot == null) return;

			await this.underlying.rewrite(snapshot);

			if (this.pending === snapshot) {
				this.pending = null;
			} else {
				// More writes arrived while this one was in flight — catch up.
				this.scheduleFlush();
			}
		});
		return this.flushing;
	}
}

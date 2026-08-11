import { IndexingQueueSnapshot } from "../types";
import { IndexingWorkerObserver } from "./indexingWorker";

export type HasPendingIndexUseCase = (noteId: string) => boolean;

export type SubscribeIndexingStateUseCase = (
	listener: (snapshot: IndexingQueueSnapshot) => void,
) => () => void;

export type GetIndexingStateUseCase = () => IndexingQueueSnapshot;


export class IndexingProgress {
	private readonly pending = new Set<string>();
	private readonly running = new Set<string>();
	private readonly failedIds = new Set<string>();
	private readonly listeners = new Set<(snapshot: IndexingQueueSnapshot) => void>();

	private processed = 0;
	private failed = 0;
	private fatalError: string | undefined;
	private emitScheduled = false;

	observe: IndexingWorkerObserver = (event) => {
		switch (event.type) {
			case "seeded":
				for (const key of event.keys) this.watch(key);
				this.scheduleEmit();
				break;
			case "enqueued":
				this.watch(event.key);
				this.scheduleEmit();
				break;
			case "started":
				this.start(event.key);
				break;
			case "settled":
				this.settle(event.key, event.error);
				break;
			case "cleared":
				// The note in flight still settles on its own; only drop what was queued.
				this.pending.clear();
				this.scheduleEmit();
				break;
			case "stopped":
				this.reportFatalError(event.error);
				break;
			case "drained":
				break;
		}
	};

	has: HasPendingIndexUseCase = (key) => this.pending.has(key) || this.running.has(key);

	hasFailed = (key: string): boolean => this.failedIds.has(key);

	subscribeIndexingState: SubscribeIndexingStateUseCase = (listener) => {
		this.listeners.add(listener);
		listener(this.getSnapshot());
		return () => {
			this.listeners.delete(listener);
		};
	};

	getSnapshot: GetIndexingStateUseCase = () => {
		const inFlight = this.running.size;
		return {
			isRunning: this.pending.size > 0 || inFlight > 0,
			currentNoteId: this.running.values().next().value,
			pending: this.pending.size,
			processed: this.processed,
			total: this.processed + this.pending.size + inFlight,
			failed: this.failed,
			fatalError: this.fatalError,
			failedIds: [...this.failedIds],
		};
	};

	reportFatalError = (error: unknown) => {
		this.fatalError = error instanceof Error ? error.message : String(error);
		this.scheduleEmit();
	};

	dispose = () => {
		this.listeners.clear();
	};

	private watch(key: string) {
		if (this.isIdle()) this.resetCounters();
		if (this.failedIds.delete(key)) {
			this.failed--;
			this.processed--;
		}
		if (!this.running.has(key)) this.pending.add(key);
	}

	private start(key: string) {
		this.watch(key);
		this.pending.delete(key);
		this.running.add(key);
		this.scheduleEmit();
	}

	private settle(key: string, error?: unknown) {
		this.running.delete(key);
		this.processed++;
		if (error !== undefined) {
			this.failedIds.add(key);
			this.failed++;
		}
		this.scheduleEmit();
	}

	private isIdle(): boolean {
		return this.pending.size === 0 && this.running.size === 0;
	}

	private resetCounters() {
		this.processed = 0;
		this.failed = 0;
		this.fatalError = undefined;
	}

	private scheduleEmit() {
		if (this.emitScheduled) return;
		this.emitScheduled = true;
		queueMicrotask(() => {
			this.emitScheduled = false;
			const snapshot = this.getSnapshot();
			for (const listener of this.listeners) listener(snapshot);
		});
	}
}

import { EmbeddingModelId, IndexedNote } from "../types";
import { IndexStorage } from "../ports";

type PendingWrite = {
	embeddingModelId: EmbeddingModelId;
	index: IndexedNote[];
};

export class ThrottledIndexStorage implements IndexStorage {
	private pending: PendingWrite | null = null;
	private timer: number | null = null;
	private flushing: Promise<void> = Promise.resolve();

	constructor(
		private readonly underlying: IndexStorage,
		private readonly intervalMs: number,
	) {
	}

	async getAll(embeddingModelId: EmbeddingModelId): Promise<IndexedNote[]> {
		if (this.pending != null && this.pending.embeddingModelId === embeddingModelId) return this.pending.index;
		return await this.underlying.getAll(embeddingModelId);
	}

	async rewrite(embeddingModelId: EmbeddingModelId, index: IndexedNote[]): Promise<void> {
		this.pending = {embeddingModelId, index};
		this.scheduleFlush();
	}

	async isEmpty(embeddingModelId: EmbeddingModelId): Promise<boolean> {
		if (this.pending != null && this.pending.embeddingModelId === embeddingModelId) return this.pending.index.length === 0;
		return await this.underlying.isEmpty(embeddingModelId);
	}

	async repair(embeddingModelId: EmbeddingModelId): Promise<void> {
		await this.flush();
		await this.underlying.repair(embeddingModelId);
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
			void this.runFlush().catch((error) => {
				console.error("[Similarity] Failed to write the index:", error);
			});
		}, this.intervalMs);
	}

	private runFlush(): Promise<void> {
		const done = this.flushing.then(async () => {
			const snapshot = this.pending;
			if (snapshot == null) return;

			await this.underlying.rewrite(snapshot.embeddingModelId, snapshot.index);

			if (this.pending === snapshot) {
				this.pending = null;
			} else {
				// More writes arrived while this one was in flight — catch up.
				this.scheduleFlush();
			}
		});

		this.flushing = done.catch(() => undefined);

		return done;
	}
}

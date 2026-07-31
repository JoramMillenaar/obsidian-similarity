import { IndexQueue, Priority } from "../domain/indexQueue";

export type { Priority };

export type EmbeddingJob<T> = () => Promise<T>;

export type EmbeddingQueueEvent =
	| { type: "started"; key: string }
	| { type: "settled"; key: string; error?: unknown }
	| { type: "drained" }
	| { type: "stopped"; error: unknown }
	| { type: "cleared" };

export type EmbeddingQueueObserver = (event: EmbeddingQueueEvent) => void | Promise<void>;

type PendingJob = {
	run: EmbeddingJob<unknown>;
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
	promise: Promise<unknown>;
};

/**
 * Serializes embedding work behind a single in-flight job so the embedder
 * (and the model backing it) is never asked to do two things at once.
 *
 * Keyed submissions coalesce: a second submit for a key that's already
 * pending joins the first job's promise instead of running twice, and — if
 * its priority is higher — promotes the existing entry rather than queueing
 * a duplicate.
 */
export class EmbeddingQueue {
	private readonly queue = new IndexQueue();
	private readonly jobs = new Map<string, PendingJob>();
	private readonly observers = new Set<EmbeddingQueueObserver>();

	private isUnloaded = false;
	private processingPromise: Promise<void> | null = null;

	submit<T>(key: string, run: EmbeddingJob<T>, priority: Priority = "low"): Promise<T> {
		if (this.isUnloaded) {
			return Promise.reject(new Error("Embedding queue is unloaded"));
		}

		const existing = this.jobs.get(key);
		if (existing) {
			this.queue.enqueue(key, priority);
			this.ensureProcessing();
			return existing.promise as Promise<T>;
		}

		let resolve!: (value: unknown) => void;
		let reject!: (error: unknown) => void;
		const promise = new Promise<unknown>((res, rej) => {
			resolve = res;
			reject = rej;
		});

		this.jobs.set(key, {run: run as EmbeddingJob<unknown>, resolve, reject, promise});
		this.queue.enqueue(key, priority);

		this.ensureProcessing();
		return promise as Promise<T>;
	}

	subscribe(observer: EmbeddingQueueObserver): () => void {
		this.observers.add(observer);
		return () => {
			this.observers.delete(observer);
		};
	}

	unload = () => {
		this.isUnloaded = true;
		this.processingPromise = null;
		this.queue.clear();

		for (const job of this.jobs.values()) {
			job.reject(new Error("Embedding queue is unloaded"));
		}
		this.jobs.clear();

		this.notify({type: "cleared"});
		this.observers.clear();
	};

	private ensureProcessing() {
		if (this.isUnloaded || this.processingPromise || this.queue.isEmpty) return;

		this.processingPromise = this.processLoop().finally(() => {
			this.processingPromise = null;
			this.ensureProcessing();
		});
	}

	private async processLoop() {
		try {
			while (true) {
				if (this.isUnloaded) return;

				const key = this.queue.take();
				if (!key) {
					await this.notify({type: "drained"});
					return;
				}

				await this.runJob(key);
				if (this.isUnloaded) return;
			}
		} catch (error) {
			if (this.isUnloaded) return;
			this.notify({type: "stopped", error});
			console.error("[Similarity] Embedding queue stopped:", error);
		}
	}

	private async runJob(key: string) {
		const job = this.jobs.get(key);
		if (!job) return;

		this.jobs.delete(key);
		this.notify({type: "started", key});

		try {
			job.resolve(await job.run());
			this.notify({type: "settled", key});
		} catch (error) {
			job.reject(error);
			this.notify({type: "settled", key, error});
			console.error(`[Similarity] Embedding job failed for ${key}:`, error);
		}
	}

	private notify(event: EmbeddingQueueEvent): Promise<void> | void {
		const pending: Promise<void>[] = [];
		for (const observer of this.observers) {
			const result = observer(event);
			if (result) pending.push(result);
		}
		if (pending.length > 0) return Promise.all(pending).then(() => undefined);
	}
}

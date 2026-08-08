import { PriorityQueue, Priority } from "../domain/priorityQueue";

export type { Priority };

export type Job<T> = () => Promise<T>;

export type JobQueueEvent =
	| { type: "started"; key: string }
	| { type: "settled"; key: string; error?: unknown }
	| { type: "drained" }
	| { type: "stopped"; error: unknown }
	| { type: "cleared" };

export type JobQueueObserver = (event: JobQueueEvent) => void | Promise<void>;

type PendingJob = {
	run: Job<unknown>;
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
	promise: Promise<unknown>;
};

export class JobQueue {
	private readonly queue = new PriorityQueue();
	private readonly jobs = new Map<string, PendingJob>();
	private readonly observers = new Set<JobQueueObserver>();

	private isUnloaded = false;
	private processingPromise: Promise<void> | null = null;

	submit<T>(key: string, run: Job<T>, priority: Priority = "low"): Promise<T> {
		if (this.isUnloaded) {
			return Promise.reject(new Error("Job queue is unloaded"));
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

		this.jobs.set(key, {run, resolve, reject, promise});
		this.queue.enqueue(key, priority);

		this.ensureProcessing();
		return promise as Promise<T>;
	}

	subscribe(observer: JobQueueObserver): () => void {
		this.observers.add(observer);
		return () => {
			this.observers.delete(observer);
		};
	}

	reset = () => {
		if (this.isUnloaded) return;
		this.rejectPending("Job queue was reset");
	};

	unload = () => {
		this.isUnloaded = true;
		this.processingPromise = null;
		this.rejectPending("Job queue is unloaded");
		this.observers.clear();
	};

	private rejectPending(message: string) {
		this.queue.clear();

		for (const job of this.jobs.values()) {
			job.reject(new Error(message));
		}
		this.jobs.clear();

		void this.notify({type: "cleared"});
	}

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
			await this.notify({type: "stopped", error});
			console.error("[Similarity] Job queue stopped:", error);
		}
	}

	private async runJob(key: string) {
		const job = this.jobs.get(key);
		if (!job) return;

		this.jobs.delete(key);
		await this.notify({type: "started", key});

		try {
			job.resolve(await job.run());
			await this.notify({type: "settled", key});
		} catch (error) {
			job.reject(error);
			await this.notify({type: "settled", key, error});
			console.error(`[Similarity] Job failed for ${key}:`, error);
		}
	}

	private notify(event: JobQueueEvent): Promise<void> | void {
		const pending: Promise<void>[] = [];
		for (const observer of this.observers) {
			const result = observer(event);
			if (result) pending.push(result);
		}
		if (pending.length > 0) return Promise.all(pending).then(() => undefined);
	}
}

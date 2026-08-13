import { Priority, PriorityQueue } from "../domain/priorityQueue";
import { IndexNoteOutcome, IndexNoteUseCase } from "./indexNote";

export type { Priority };

export type IndexTaskOutcome = IndexNoteOutcome | "cancelled";

export type IndexingWorkerEvent =
	| { type: "seeded"; keys: string[] }
	| { type: "enqueued"; key: string }
	| { type: "started"; key: string }
	| { type: "settled"; key: string; error?: unknown }
	| { type: "drained" }
	| { type: "stopped"; error: unknown }
	| { type: "cleared" };

export type IndexingWorkerObserver = (event: IndexingWorkerEvent) => void | Promise<void>;

type PendingNote = {
	resolve: (outcome: IndexTaskOutcome) => void;
	reject: (error: unknown) => void;
	promise: Promise<IndexTaskOutcome>;
};

type UrgentJob = {
	execute: () => Promise<void>;
	cancel: (error: unknown) => void;
};

export class IndexingWorker {
	private readonly foreground = new PriorityQueue();
	private readonly pendingNotes = new Map<string, PendingNote>();
	private readonly urgent: UrgentJob[] = [];
	private readonly observers = new Set<IndexingWorkerObserver>();

	private backlogOrder: string[] = [];
	private backlogCursor = 0;
	private backlogRemaining = new Set<string>();

	private drainedWaiters: Array<() => void> = [];
	private loop: Promise<void> | null = null;
	private inFlight: Promise<void> | null = null;
	private paused = false;
	private isUnloaded = false;

	constructor(private readonly indexNote: IndexNoteUseCase) { }

	submitNote(noteId: string, priority: Priority = "medium"): Promise<IndexTaskOutcome> {
		if (this.isUnloaded) return Promise.resolve("cancelled");

		this.backlogRemaining.delete(noteId);

		const existing = this.pendingNotes.get(noteId);
		if (existing) {
			this.foreground.enqueue(noteId, priority);
			this.ensureRunning();
			return existing.promise;
		}

		let resolve!: (outcome: IndexTaskOutcome) => void;
		let reject!: (error: unknown) => void;
		const promise = new Promise<IndexTaskOutcome>((res, rej) => {
			resolve = res;
			reject = rej;
		});

		this.pendingNotes.set(noteId, {resolve, reject, promise});
		this.foreground.enqueue(noteId, priority);

		void this.notify({type: "enqueued", key: noteId});
		this.ensureRunning();
		return promise;
	}

	promote(noteId: string, priority: Priority): Promise<IndexTaskOutcome> | null {
		if (this.isUnloaded) return null;
		if (!this.pendingNotes.has(noteId) && !this.backlogRemaining.has(noteId)) return null;
		return this.submitNote(noteId, priority);
	}

	submitEmbed<T>(run: () => Promise<T>): Promise<T> {
		if (this.isUnloaded) return Promise.reject(new Error("Indexing worker is unloaded"));

		let resolve!: (value: T) => void;
		let reject!: (error: unknown) => void;
		const promise = new Promise<T>((res, rej) => {
			resolve = res;
			reject = rej;
		});

		this.urgent.push({
			execute: async () => {
				try {
					resolve(await run());
				} catch (error) {
					reject(error);
				}
			},
			cancel: reject,
		});

		this.ensureRunning();
		return promise;
	}

	setBacklog(noteIds: string[]): void {
		if (this.isUnloaded) return;

		this.backlogOrder = noteIds;
		this.backlogCursor = 0;
		this.backlogRemaining = new Set(noteIds);
		for (const queued of this.pendingNotes.keys()) this.backlogRemaining.delete(queued);

		void this.notify({type: "seeded", keys: noteIds});
		this.ensureRunning();
	}

	whenDrained(): Promise<void> {
		if (this.isUnloaded || this.isIdle()) return Promise.resolve();
		return new Promise<void>((resolve) => {
			this.drainedWaiters.push(resolve);
		});
	}

	async pause(): Promise<void> {
		this.paused = true;
		await this.inFlight;
	}

	resume(): void {
		if (!this.paused) return;
		this.paused = false;
		this.ensureRunning();
	}

	reset = async (): Promise<void> => {
		if (this.isUnloaded) return;
		this.clearQueues("Indexing worker was reset");
		await this.inFlight;
	};

	unload = (): void => {
		this.isUnloaded = true;
		this.paused = false;
		this.loop = null;
		this.clearQueues("Indexing worker is unloaded");
		this.observers.clear();
	};

	subscribe(observer: IndexingWorkerObserver): () => void {
		this.observers.add(observer);
		return () => {
			this.observers.delete(observer);
		};
	}

	private clearQueues(message: string) {
		this.foreground.clear();
		this.backlogOrder = [];
		this.backlogCursor = 0;
		this.backlogRemaining.clear();

		for (const note of this.pendingNotes.values()) note.resolve("cancelled");
		this.pendingNotes.clear();

		for (const job of this.urgent.splice(0)) job.cancel(new Error(message));

		void this.notify({type: "cleared"});
		this.releaseDrainedWaiters();
	}

	private ensureRunning() {
		if (this.isUnloaded || this.paused || this.loop || !this.hasWork()) return;

		this.loop = this.runLoop().finally(() => {
			this.loop = null;
			this.ensureRunning();
		});
	}

	private async runLoop(): Promise<void> {
		try {
			while (!this.isUnloaded && !this.paused) {
				const job = this.urgent.shift();
				if (job) {
					await this.track(job.execute());
					continue;
				}

				const noteId = this.takeNextNoteId();
				if (!noteId) {
					await this.notify({type: "drained"});
					return;
				}

				await this.processNote(noteId);
			}
		} catch (error) {
			if (this.isUnloaded) return;
			await this.notify({type: "stopped", error});
			console.error("[Similarity] Indexing worker stopped:", error);
		} finally {
			if (!this.hasWork()) this.releaseDrainedWaiters();
		}
	}

	private takeNextNoteId(): string | null {
		const queued = this.foreground.take();
		if (queued) return queued;

		while (this.backlogCursor < this.backlogOrder.length) {
			const noteId = this.backlogOrder[this.backlogCursor++];
			if (this.backlogRemaining.delete(noteId)) return noteId;
		}

		this.backlogOrder = [];
		this.backlogCursor = 0;
		this.backlogRemaining.clear();
		return null;
	}

	private async processNote(noteId: string): Promise<void> {
		const pending = this.pendingNotes.get(noteId);
		this.pendingNotes.delete(noteId);

		await this.notify({type: "started", key: noteId});

		const run = this.indexNote(noteId);
		this.inFlight = run.then(() => undefined, () => undefined);

		try {
			const outcome = await run;
			pending?.resolve(outcome);
			await this.notify({type: "settled", key: noteId});
		} catch (error) {
			pending?.reject(error);
			await this.notify({type: "settled", key: noteId, error});
			console.error(`[Similarity] Indexing failed for ${noteId}:`, error);
		} finally {
			this.inFlight = null;
		}
	}

	private async track(run: Promise<void>): Promise<void> {
		this.inFlight = run;
		try {
			await run;
		} finally {
			this.inFlight = null;
		}
	}

	private hasWork(): boolean {
		return this.urgent.length > 0 || !this.foreground.isEmpty || this.backlogCursor < this.backlogOrder.length;
	}

	private isIdle(): boolean {
		return this.loop === null && !this.hasWork();
	}

	private releaseDrainedWaiters() {
		const waiters = this.drainedWaiters;
		this.drainedWaiters = [];
		for (const resolve of waiters) resolve();
	}

	private notify(event: IndexingWorkerEvent): Promise<void> | void {
		const pending: Promise<void>[] = [];
		for (const observer of this.observers) {
			try {
				const result = observer(event);
				if (result) pending.push(result.catch((error) => this.reportObserverFailure(event, error)));
			} catch (error) {
				this.reportObserverFailure(event, error);
			}
		}
		if (pending.length > 0) return Promise.all(pending).then(() => undefined);
	}

	private reportObserverFailure(event: IndexingWorkerEvent, error: unknown): void {
		console.error(`[Similarity] Indexing worker observer failed on "${event.type}":`, error);
	}
}

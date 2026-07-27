import {
	bumpQueuedNote,
	createEmptyIndexQueue,
	dequeueNextQueuedNote,
	mergeSeedQueue,
	removeQueuedNotes,
} from "../domain/indexingQueue";
import { IndexingQueueSnapshot, SyncResults } from "../types";

export class IndexingRuntime {
	private queue = createEmptyIndexQueue();
	private currentNoteId: string | undefined;
	private isRunning = false;
	private processedInRun = 0;
	private failedInRun = 0;
	private hasCompletedInitialIndex = false;
	private fatalError: string | undefined;
	private lifetimeIndexed = 0;
	private lifetimeDeleted = 0;
	private readonly listeners = new Set<(snapshot: IndexingQueueSnapshot) => void>();
	private readonly noteWaiters = new Map<string, Array<() => void>>();
	private drainWaiters: Array<() => void> = [];

	subscribe(listener: (snapshot: IndexingQueueSnapshot) => void): () => void {
		this.listeners.add(listener);
		listener(this.getSnapshot());
		return () => {
			this.listeners.delete(listener);
		};
	}

	getSnapshot(): IndexingQueueSnapshot {
		return {
			isRunning: this.isRunning,
			hasCompletedInitialIndex: this.hasCompletedInitialIndex,
			currentNoteId: this.currentNoteId,
			pending: this.queue.length,
			processed: this.processedInRun,
			total: this.processedInRun + this.queue.length + (this.currentNoteId ? 1 : 0),
			failed: this.failedInRun,
			fatalError: this.fatalError,
		};
	}

	getLifetimeResults(): SyncResults {
		return {
			indexed: this.lifetimeIndexed,
			deleted: this.lifetimeDeleted,
		};
	}

	hasPendingWork(): boolean {
		return this.queue.length > 0;
	}

	getCurrentNoteId(): string | undefined {
		return this.currentNoteId;
	}

	hasFatalError(): boolean {
		return Boolean(this.fatalError);
	}

	getFatalError(): string | undefined {
		return this.fatalError;
	}

	hasCompletedInitialPass(): boolean {
		return this.hasCompletedInitialIndex;
	}

	setInitialIndexCompleted(value: boolean) {
		if (this.hasCompletedInitialIndex === value) {
			return;
		}

		this.hasCompletedInitialIndex = value;
		this.emit();
	}

	markInitialIndexCompleted() {
		this.hasCompletedInitialIndex = true;
		this.emit();
	}

	beginRun() {
		this.processedInRun = 0;
		this.failedInRun = 0;
		this.fatalError = undefined;
		this.isRunning = true;
		this.emit();
	}

	takeNext(): string | null {
		const next = dequeueNextQueuedNote(this.queue);
		if (!next) {
			return null;
		}

		this.queue = next.queue;
		this.currentNoteId = next.noteId;
		this.isRunning = true;
		this.emit();
		return next.noteId;
	}

	finishCurrent(noteId: string) {
		this.processedInRun++;
		this.currentNoteId = undefined;
		this.resolveNoteWaiters(noteId);
		this.emit();
	}

	recordIndexed() {
		this.lifetimeIndexed++;
	}

	recordDeleted(noteIds: string[]) {
		if (noteIds.length === 0) {
			return;
		}

		this.lifetimeDeleted += noteIds.length;
		this.emit();
	}

	recordProcessingFailure() {
		this.failedInRun++;
	}

	finishRun() {
		this.currentNoteId = undefined;
		this.isRunning = false;
		this.emit();
		this.resolveDrainWaiters();
	}

	markFatalError(message: string) {
		this.currentNoteId = undefined;
		this.isRunning = false;
		this.fatalError = message;
		this.emit();
		this.resolveDrainWaiters();
	}

	clearFatalError() {
		if (!this.fatalError) {
			return;
		}

		this.fatalError = undefined;
		this.emit();
	}

	replaceSeedQueue(seedIds: string[]) {
		this.queue = mergeSeedQueue(this.queue, seedIds);
		this.emit();
	}

	bump(noteId: string) {
		if (this.currentNoteId === noteId) {
			return;
		}

		this.queue = bumpQueuedNote(this.queue, noteId);
		this.emit();
	}

	removeQueuedNotes(noteIds: string[]) {
		if (noteIds.length === 0) {
			return;
		}

		const before = this.queue;
		this.queue = removeQueuedNotes(this.queue, noteIds);
		if (before === this.queue) {
			return;
		}

		for (const noteId of noteIds) {
			if (!this.queue.includes(noteId) && this.currentNoteId !== noteId) {
				this.resolveNoteWaiters(noteId);
			}
		}
		this.emit();
	}

	async awaitNote(noteId: string): Promise<void> {
		if (!this.currentNoteId && !this.queue.includes(noteId)) {
			return;
		}

		await new Promise<void>((resolve) => {
			const current = this.noteWaiters.get(noteId) ?? [];
			this.noteWaiters.set(noteId, [...current, resolve]);
		});
	}

	async awaitIdle(): Promise<void> {
		if (!this.isRunning && !this.currentNoteId && !this.hasPendingWork()) {
			return;
		}

		await new Promise<void>((resolve) => {
			this.drainWaiters.push(resolve);
		});
	}

	unload() {
		this.queue = createEmptyIndexQueue();
		this.currentNoteId = undefined;
		this.isRunning = false;

		for (const waiters of this.noteWaiters.values()) {
			for (const waiter of waiters) {
				waiter();
			}
		}
		this.noteWaiters.clear();

		this.resolveDrainWaiters();
		this.listeners.clear();
	}

	private resolveNoteWaiters(noteId: string) {
		const waiters = this.noteWaiters.get(noteId);
		if (!waiters?.length) {
			return;
		}

		this.noteWaiters.delete(noteId);
		for (const waiter of waiters) {
			waiter();
		}
	}

	private resolveDrainWaiters() {
		for (const waiter of this.drainWaiters) {
			waiter();
		}
		this.drainWaiters = [];
	}

	private emit() {
		const snapshot = this.getSnapshot();
		for (const listener of this.listeners) {
			listener(snapshot);
		}
	}
}

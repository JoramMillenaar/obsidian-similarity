import { IndexingQueueSnapshot } from "../types";
import { UniqueDeque } from "../domain/uniqueDeque";

export class IndexingRuntime {
	private queue = new UniqueDeque();
	private isRunning = false;
	private processedInRun = 0;
	private failedInRun = 0;
	private fatalError: string | undefined;
	private readonly listeners = new Set<(snapshot: IndexingQueueSnapshot) => void>();

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
			pending: this.queue.length,
			processed: this.processedInRun,
			total: this.processedInRun + this.queue.length,
			failed: this.failedInRun,
			fatalError: this.fatalError,
		};
	}

	hasPendingWork(): boolean {
		return this.queue.length > 0;
	}

	beginRun() {
		this.processedInRun = 0;
		this.failedInRun = 0;
		this.fatalError = undefined;
		this.isRunning = true;
		this.emit();
	}

	takeNext(): string | null {
		const noteId = this.queue.popLeft();
		if (!noteId) return null;

		this.isRunning = true;
		this.emit();
		return noteId;
	}

	finishCurrent() {
		this.processedInRun++;
		this.emit();
	}

	recordProcessingFailure() {
		this.failedInRun++;
	}

	finishRun() {
		this.isRunning = false;
		this.emit();
	}

	markFatalError(message: string) {
		this.isRunning = false;
		this.fatalError = message;
		this.emit();
	}

	replaceSeedQueue(seedIds: string[]) {
		this.queue.mergeRight(seedIds);
		this.emit();
	}

	bump(noteId: string) {
		this.queue.bumpLeft(noteId);
		this.emit();
	}

	removeQueuedNotes(noteIds: string[]) {
		if (noteIds.length === 0) {
			return;
		}

		const removedAny = noteIds.some((noteId) => this.queue.has(noteId));
		this.queue.removeMany(noteIds);
		if (!removedAny) {
			return;
		}

		this.emit();
	}

	unload() {
		this.queue = new UniqueDeque();
		this.isRunning = false;
		this.listeners.clear();
	}

	private emit() {
		const snapshot = this.getSnapshot();
		for (const listener of this.listeners) {
			listener(snapshot);
		}
	}
}

import { IndexingQueueSnapshot } from "../types";
import { UniqueDeque } from "../domain/uniqueDeque";

export class IndexingRuntime {
	private queue = new UniqueDeque();
	private currentNoteId: string | undefined;
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
			currentNoteId: this.currentNoteId,
			pending: this.queue.length,
			processed: this.processedInRun,
			total: this.processedInRun + this.queue.length + (this.currentNoteId ? 1 : 0),
			failed: this.failedInRun,
			fatalError: this.fatalError,
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

	beginRun() {
		this.processedInRun = 0;
		this.failedInRun = 0;
		this.fatalError = undefined;
		this.isRunning = true;
		this.emit();
	}

	takeNext(): string | null {
		const noteId = this.queue.popLeft();
		if (!noteId) {
			return null;
		}

		this.currentNoteId = noteId;
		this.isRunning = true;
		this.emit();
		return noteId;
	}

	finishCurrent() {
		this.processedInRun++;
		this.currentNoteId = undefined;
		this.emit();
	}

	recordDeleted(noteIds: string[]) {
		if (noteIds.length === 0) {
			return;
		}

		this.emit();
	}

	recordProcessingFailure() {
		this.failedInRun++;
	}

	finishRun() {
		this.currentNoteId = undefined;
		this.isRunning = false;
		this.emit();
	}

	markFatalError(message: string) {
		this.currentNoteId = undefined;
		this.isRunning = false;
		this.fatalError = message;
		this.emit();
	}

	replaceSeedQueue(seedIds: string[]) {
		this.queue.mergeRight(seedIds);
		this.emit();
	}

	bump(noteId: string) {
		if (this.currentNoteId === noteId) return;

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
		this.currentNoteId = undefined;
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

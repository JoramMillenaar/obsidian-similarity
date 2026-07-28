import { IndexingQueueSnapshot } from "../types";
import { IndexRepository } from "../ports";
import { IndexNoteUseCase } from "./indexNote";
import { IndexingRuntime } from "./indexingRuntime";

type IndexSyncWorkerDeps = {
	indexRepo: IndexRepository;
	indexNote: IndexNoteUseCase;
};

export class IndexSyncWorker {
	private readonly runtime = new IndexingRuntime();
	private isUnloaded = false;
	private processingPromise: Promise<void> | null = null;

	constructor(private readonly deps: IndexSyncWorkerDeps) {}

	enqueue(seedIds: string[]) {
		if (this.isUnloaded) return;
		this.runtime.replaceSeedQueue(seedIds);
		this.ensureProcessing();
	}

	bump(noteId: string) {
		if (this.isUnloaded) return;
		this.runtime.bump(noteId);
		this.ensureProcessing();
	}

	removeQueued(noteIds: string[]) {
		if (this.isUnloaded) return;
		this.runtime.removeQueuedNotes(noteIds);
	}

	markFatalError(message: string) {
		if (this.isUnloaded) return;
		this.runtime.markFatalError(message);
	}

	subscribeQueueSnapshot(listener: (snapshot: IndexingQueueSnapshot) => void): () => void {
		if (this.isUnloaded) return () => {};
		return this.runtime.subscribe(listener);
	}

	getSnapshot(): IndexingQueueSnapshot {
		return this.runtime.getSnapshot();
	}

	unload() {
		this.isUnloaded = true;
		this.processingPromise = null;
		this.runtime.unload();
	}

	private async processLoop() {
		try {
			while (true) {
				if (this.isUnloaded) {
					this.runtime.finishRun();
					return;
				}

				const noteId = this.runtime.takeNext();
				if (!noteId) {
					await this.deps.indexRepo.flush();
					this.runtime.finishRun();
					return;
				}

				try {
					await this.deps.indexNote(noteId);
				} catch (error) {
					this.runtime.recordProcessingFailure();
					console.error(`[Similarity] Failed to index note ${noteId}:`, error);
				}

				this.runtime.finishCurrent();

				if (this.isUnloaded) {
					this.runtime.finishRun();
					return;
				}
			}
		} catch (error) {
			if (this.isUnloaded) {
				return;
			}

			const message = error instanceof Error ? error.message : String(error);
			this.runtime.markFatalError(message);
			console.error("[Similarity] Indexing worker stopped:", error);
		}
	}

	private ensureProcessing() {
		if (this.isUnloaded || this.processingPromise || !this.runtime.hasPendingWork()) {
			return;
		}

		this.runtime.beginRun();
		this.processingPromise = this.processLoop().finally(() => {
			this.processingPromise = null;
		});
	}
}

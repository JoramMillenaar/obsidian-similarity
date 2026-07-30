import { isMarkdownPath } from "../domain/markdownPath";
import { IndexQueue } from "../domain/indexQueue";
import { IndexingQueueSnapshot } from "../types";
import { IndexRepository } from "../ports";
import { IndexNoteUseCase } from "./indexNote";
import { IsIgnoredPath } from "./isIgnoredPath";
import { BuildIndexSyncPlanUseCase, IndexSyncPlan } from "./buildIndexSyncPlan";

export type SynchronizeIndexUseCase = () => Promise<void>;

export type BumpIndexPriorityUseCase = (noteId: string) => Promise<void>;

export type SubscribeIndexingStateUseCase = (
	listener: (snapshot: IndexingQueueSnapshot) => void,
) => () => void;

export type GetIndexingStateUseCase = () => IndexingQueueSnapshot;

type IndexSyncWorkerDeps = {
	indexRepo: IndexRepository;
	indexNote: IndexNoteUseCase;
	buildIndexSyncPlan: BuildIndexSyncPlanUseCase;
	isIgnoredPath: IsIgnoredPath;
};

export class IndexSyncWorker {
	private readonly queue = new IndexQueue();
	private readonly failedIds = new Set<string>();
	private readonly listeners = new Set<(snapshot: IndexingQueueSnapshot) => void>();

	private isUnloaded = false;
	private isRunning = false;
	private processedInRun = 0;
	private failedInRun = 0;
	private fatalError: string | undefined;
	private processingPromise: Promise<void> | null = null;
	private refreshChain: Promise<void> = Promise.resolve();

	constructor(private readonly deps: IndexSyncWorkerDeps) {}

	synchronizeIndex: SynchronizeIndexUseCase = async () => {
		if (this.isUnloaded) return;

		const run = async (): Promise<void> => {
			if (this.isUnloaded) return;

			try {
				const plan = await this.deps.buildIndexSyncPlan();
				await this.applyPlan(plan);
			} catch (error) {
				this.failRun(error, "Failed to refresh indexing queue");
			}
		};

		const next = this.refreshChain.then(run, run);
		this.refreshChain = next.then(() => undefined, () => undefined);
		return await next;
	};

	bumpPriority: BumpIndexPriorityUseCase = async (noteId) => {
		if (this.isUnloaded) return;
		if (!isMarkdownPath(noteId)) return;
		if (await this.deps.isIgnoredPath(noteId)) return;

		this.failedIds.delete(noteId);
		this.queue.bump(noteId);
		this.emit();
		this.ensureProcessing();
	};

	subscribeIndexingState: SubscribeIndexingStateUseCase = (listener) => {
		if (this.isUnloaded) return () => {};

		this.listeners.add(listener);
		listener(this.getSnapshot());
		return () => {
			this.listeners.delete(listener);
		};
	};

	getSnapshot: GetIndexingStateUseCase = () => ({
		isRunning: this.isRunning,
		pending: this.queue.pending,
		processed: this.processedInRun,
		total: this.processedInRun + this.queue.pending,
		failed: this.failedInRun,
		fatalError: this.fatalError,
	});

	unload = () => {
		this.isUnloaded = true;
		this.refreshChain = Promise.resolve();
		this.processingPromise = null;
		this.queue.clear();
		this.failedIds.clear();
		this.isRunning = false;
		this.listeners.clear();
	};

	private async applyPlan(plan: IndexSyncPlan) {
		for (const noteId of plan.idsToRemoveFromIndex) {
			await this.deps.indexRepo.remove(noteId);
		}

		const toSeed = plan.idsToSeed.filter((id) => !this.failedIds.has(id));
		this.queue.seed(toSeed);
		this.emit();
		this.ensureProcessing();
	}

	private ensureProcessing() {
		if (this.isUnloaded || this.processingPromise || this.queue.isEmpty) return;

		this.processedInRun = 0;
		this.failedInRun = 0;
		this.fatalError = undefined;
		this.isRunning = true;
		this.emit();
		this.processingPromise = this.processLoop().finally(() => {
			this.processingPromise = null;
		});
	}

	private async processLoop() {
		try {
			while (true) {
				if (this.isUnloaded) return;

				const noteId = this.queue.take();
				if (!noteId) {
					await this.deps.indexRepo.flush();
					this.isRunning = false;
					this.emit();
					return;
				}

				try {
					await this.deps.indexNote(noteId);
				} catch (error) {
					this.failedInRun++;
					this.failedIds.add(noteId);
					console.error(`[Similarity] Failed to index note ${noteId}:`, error);
				}

				this.processedInRun++;
				this.emit();

				if (this.isUnloaded) return;
			}
		} catch (error) {
			if (this.isUnloaded) return;
			this.failRun(error, "Indexing worker stopped");
		}
	}

	private failRun(error: unknown, context: string) {
		this.fatalError = error instanceof Error ? error.message : String(error);
		this.isRunning = false;
		this.emit();
		console.error(`[Similarity] ${context}:`, error);
	}

	private emit() {
		const snapshot = this.getSnapshot();
		for (const listener of this.listeners) {
			listener(snapshot);
		}
	}
}

export function makeIndexSyncWorker(deps: IndexSyncWorkerDeps): IndexSyncWorker {
	return new IndexSyncWorker(deps);
}

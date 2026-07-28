import { isPathIgnored } from "../domain/ignoreRules";
import { isMarkdownPath } from "../domain/markdownPath";
import { IndexingQueueSnapshot } from "../types";
import { IndexRepository, SettingsRepository } from "../ports";
import { IndexNoteUseCase } from "./indexNote";
import { IndexingRuntime } from "./indexingRuntime";
import { BuildIndexSyncPlanUseCase, IndexSyncPlan } from "./buildIndexSyncPlan";

export type SynchronizeIndexUseCase = (args?: {
	forceReindexAll?: boolean;
}) => Promise<void>;

export type BumpIndexPriorityUseCase = (noteId: string) => Promise<void>;

export type SubscribeIndexingStateUseCase = (
	listener: (snapshot: IndexingQueueSnapshot) => void,
) => () => void;

export type GetIndexingStateUseCase = () => IndexingQueueSnapshot;

type IndexingCoordinatorDeps = {
	indexRepo: IndexRepository;
	settingsRepo: SettingsRepository;
	indexNote: IndexNoteUseCase;
	buildIndexSyncPlan: BuildIndexSyncPlanUseCase;
};

export class IndexingCoordinator {
	private readonly runtime = new IndexingRuntime();
	private isUnloaded = false;
	private processingPromise: Promise<void> | null = null;
	private refreshChain: Promise<void> = Promise.resolve();

	constructor(private readonly deps: IndexingCoordinatorDeps) {}

	synchronizeIndex: SynchronizeIndexUseCase = async (args = {}) => {
		if (this.isUnloaded) return;

		const run = async (): Promise<void> => {
			if (this.isUnloaded) return;

			try {
				if (args.forceReindexAll) {
					await this.deps.indexRepo.clear();
				}
				const plan = await this.deps.buildIndexSyncPlan();
				await this.applySyncPlan(plan);
				this.ensureProcessing();
				if (!this.processingPromise) {
					await this.maybePersistInitialIndexCompleted();
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.runtime.markFatalError(message);
				console.error("[Similarity] Failed to refresh indexing queue:", error);
			}
		};

		const next = this.refreshChain.then(run, run);
		this.refreshChain = next.then(() => undefined, () => undefined);
		return await next;
	};

	bumpPriority: BumpIndexPriorityUseCase = async (noteId) => {
		if (this.isUnloaded) return;

		if (!isMarkdownPath(noteId)) return;

		if (this.runtime.getCurrentNoteId() === noteId) return

		const settings = await this.deps.settingsRepo.get();
		if (isPathIgnored(noteId, settings.ignoredPaths)) {
			this.runtime.removeQueuedNotes([noteId]);
			await this.deps.indexRepo.remove(noteId);
			this.runtime.recordDeleted([noteId]);
			return;
		}

		this.runtime.bump(noteId);
		this.ensureProcessing();
	};

	subscribe: SubscribeIndexingStateUseCase = (listener) => {
		if (this.isUnloaded) return () => {};
		return this.runtime.subscribe(listener);
	};

	getSnapshot: GetIndexingStateUseCase = () => this.runtime.getSnapshot();

	unload = () => {
		this.isUnloaded = true;
		this.processingPromise = null;
		this.refreshChain = Promise.resolve();
		this.runtime.unload();
	};

	private async maybePersistInitialIndexCompleted() {
		if (
			this.isUnloaded
			|| this.runtime.getCurrentNoteId()
			|| this.runtime.hasPendingWork()
			|| this.runtime.hasFatalError()
		) {
			return;
		}
	}

	private async applySyncPlan(plan: IndexSyncPlan) {
		for (const noteId of plan.idsToRemoveFromIndex) {
			await this.deps.indexRepo.remove(noteId);
		}

		this.runtime.recordDeleted(plan.idsToRemoveFromIndex);
		this.runtime.replaceSeedQueue(plan.idsToSeed);
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
					await this.maybePersistInitialIndexCompleted();
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
			console.error("[Similarity] Indexing coordinator stopped:", error);
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

export function makeIndexingCoordinator(deps: IndexingCoordinatorDeps): IndexingCoordinator {
	return new IndexingCoordinator(deps);
}

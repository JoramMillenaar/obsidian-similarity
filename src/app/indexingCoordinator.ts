import { isPathIgnored } from "../domain/ignoreRules";
import { isMarkdownPath } from "../domain/markdownPath";
import {
	IndexingPriorityReason,
	IndexingQueueSnapshot,
	SyncResults,
} from "../types";
import { IndexRepository, NoteSource, SettingsRepository } from "../ports";
import { IndexNoteOutcome, IndexNoteUseCase } from "./indexNote";
import { SummarizeNoteUseCase } from "./summarizeNote";
import { IndexingRuntime } from "./indexingRuntime";
import {
	BuildIndexSyncPlanUseCase,
	makeBuildIndexSyncPlan,
} from "./buildIndexSyncPlan";

export type StartOrRefreshIndexSyncUseCase = (args?: {
	awaitCompletion?: boolean;
	forceReindexAll?: boolean;
}) => Promise<SyncResults>;

export type BumpIndexPriorityUseCase = (
	noteId: string,
	reason: Exclude<IndexingPriorityReason, "seed">,
) => Promise<void>;

export type AwaitIndexedNoteUseCase = (noteId: string) => Promise<void>;

export type SubscribeIndexingStateUseCase = (
	listener: (snapshot: IndexingQueueSnapshot) => void,
) => () => void;

export type GetIndexingStateUseCase = () => IndexingQueueSnapshot;

type IndexingCoordinatorDeps = {
	noteSource: NoteSource;
	indexRepo: IndexRepository;
	settingsRepo: SettingsRepository;
	indexNote: IndexNoteUseCase;
	summarizeNote: SummarizeNoteUseCase;
};

export class IndexingCoordinator {
	private readonly runtime = new IndexingRuntime();
	private readonly buildIndexSyncPlan: BuildIndexSyncPlanUseCase;
	private hasLoadedInitialIndexState = false;
	private isUnloaded = false;
	private processingPromise: Promise<void> | null = null;
	private refreshChain: Promise<void> = Promise.resolve();

	constructor(private readonly deps: IndexingCoordinatorDeps) {
		this.buildIndexSyncPlan = makeBuildIndexSyncPlan({
			noteSource: deps.noteSource,
			indexRepo: deps.indexRepo,
			settingsRepo: deps.settingsRepo,
		});
	}

	startOrRefreshSync: StartOrRefreshIndexSyncUseCase = async (args = {}) => {
		if (this.isUnloaded) {
			return {indexed: 0, deleted: 0};
		}

		const run = async (): Promise<SyncResults> => {
			if (this.isUnloaded) {
				return {indexed: 0, deleted: 0};
			}

			await this.ensureInitialStateLoaded();
			const before = this.runtime.getLifetimeResults();

			try {
				await this.applySyncPlan({forceReindexAll: args.forceReindexAll});
				this.ensureProcessing();
				if (!this.processingPromise) {
					await this.maybePersistInitialIndexCompleted();
				}
				if (args.awaitCompletion) {
					await this.runtime.awaitIdle();
					if (this.runtime.hasFatalError()) {
						throw new Error(this.runtime.getFatalError());
					}
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.runtime.markFatalError(message);
				console.error("[Similarity] Failed to refresh indexing queue:", error);
				if (args.awaitCompletion) {
					throw error;
				}
			}

			const after = this.runtime.getLifetimeResults();
			return {
				indexed: after.indexed - before.indexed,
				deleted: after.deleted - before.deleted,
			};
		};

		const next = this.refreshChain.then(run, run);
		this.refreshChain = next.then(() => undefined, () => undefined);
		return await next;
	};

	bumpPriority: BumpIndexPriorityUseCase = async (noteId, reason) => {
		if (this.isUnloaded) {
			return;
		}

		await this.ensureInitialStateLoaded();

		if (!isMarkdownPath(noteId)) {
			return;
		}
		if (this.runtime.getCurrentNoteId() === noteId) {
			return;
		}

		const settings = await this.deps.settingsRepo.get();
		if (isPathIgnored(noteId, settings.ignoredPaths)) {
			this.runtime.removeQueuedNotes([noteId]);
			await this.deps.indexRepo.remove(noteId);
			this.runtime.recordDeleted([noteId]);
			return;
		}

		this.runtime.bump(noteId, reason);
		this.ensureProcessing();
	};

	awaitNote: AwaitIndexedNoteUseCase = async (noteId) => {
		if (this.isUnloaded) {
			return;
		}

		await this.runtime.awaitNote(noteId);
	};

	subscribe: SubscribeIndexingStateUseCase = (listener) => {
		if (this.isUnloaded) {
			return () => {};
		}

		const unsubscribe = this.runtime.subscribe(listener);
		void this.ensureInitialStateLoaded();
		return unsubscribe;
	};

	getSnapshot: GetIndexingStateUseCase = () => this.runtime.getSnapshot();

	unload = () => {
		this.isUnloaded = true;
		this.processingPromise = null;
		this.refreshChain = Promise.resolve();
		this.runtime.unload();
	};

	private async ensureInitialStateLoaded() {
		if (this.hasLoadedInitialIndexState || this.isUnloaded) {
			return;
		}

		this.runtime.setInitialIndexCompleted(
			(await this.deps.settingsRepo.get()).initialIndexCompleted,
		);
		this.hasLoadedInitialIndexState = true;
	}

	private async maybePersistInitialIndexCompleted() {
		if (
			this.isUnloaded
			|| this.runtime.hasCompletedInitialPass()
			|| this.runtime.getCurrentNoteId()
			|| this.runtime.hasPendingWork()
			|| this.runtime.hasFatalError()
		) {
			return;
		}

		this.runtime.markInitialIndexCompleted();
		await this.deps.settingsRepo.updatePartial({initialIndexCompleted: true});
	}

	private async applySyncPlan(args: {forceReindexAll?: boolean}) {
		const plan = await this.buildIndexSyncPlan({
			queuedIds: this.runtime.getQueuedIds(),
			forceReindexAll: args.forceReindexAll,
		});

		for (const noteId of plan.idsToRemoveFromIndex) {
			await this.deps.indexRepo.remove(noteId);
		}

		this.runtime.recordDeleted(plan.idsToRemoveFromIndex);
		this.runtime.removeQueuedNotes([
			...plan.idsToRemoveFromIndex,
			...plan.idsToRemoveFromQueue,
		]);
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

					// Every note is embedded, so their average meanings are final and
					// descriptions can be derived. This can take a while, so it yields
					// the moment new indexing work shows up.
					await this.runSummarizingPass();
					if (this.runtime.hasPendingWork()) continue;

					this.runtime.finishRun();
					await this.maybePersistInitialIndexCompleted();
					return;
				}

				let outcome: IndexNoteOutcome | undefined;
				try {
					outcome = await this.deps.indexNote(noteId);
				} catch (error) {
					this.runtime.recordProcessingFailure();
					console.error(`[Similarity] Failed to index note ${noteId}:`, error);
				}

				if (outcome === "indexed") {
					this.runtime.recordIndexed();
				}

				this.runtime.finishCurrent(noteId);

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

	/**
	 * Backfills centroid descriptions for notes that lack one. Indexing clears a
	 * note's centroid whenever it rewrites it, so "missing" doubles as the queue:
	 * the pass is incremental, resumes after a crash, and catches up with edits
	 * without any bookkeeping of its own.
	 */
	private async runSummarizingPass(): Promise<void> {
		const pending = (await this.deps.indexRepo.listAll())
			.filter((note) => note.centroid === undefined);
		if (pending.length === 0) {
			return;
		}

		this.runtime.beginSummarizing(pending.length);
		try {
			for (const note of pending) {
				// Indexing is what users are waiting on — let it interrupt us. The
				// leftovers get picked up on the next drain.
				if (this.isUnloaded || this.runtime.hasPendingWork()) {
					return;
				}

				try {
					await this.deps.summarizeNote(note.id);
				} catch (error) {
					console.error(`[Similarity] Failed to summarize note ${note.id}:`, error);
				}

				this.runtime.recordSummarized();
			}

			await this.deps.indexRepo.flush();
		} finally {
			this.runtime.finishSummarizing();
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

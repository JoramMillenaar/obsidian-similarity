import { isPathIgnored } from "../domain/ignoreRules";
import { isMarkdownPath } from "../domain/markdownPath";
import { IndexingQueueSnapshot } from "../types";
import { IndexRepository, SettingsRepository } from "../ports";
import { IndexNoteUseCase } from "./indexNote";
import { IndexSyncWorker } from "./indexSyncWorker";
import { BuildIndexSyncPlanUseCase, IndexSyncPlan } from "./buildIndexSyncPlan";

export type SynchronizeIndexUseCase = () => Promise<void>;

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
	private readonly worker: IndexSyncWorker;
	private isUnloaded = false;
	private refreshChain: Promise<void> = Promise.resolve();

	constructor(private readonly deps: IndexingCoordinatorDeps) {
		this.worker = new IndexSyncWorker({
			indexRepo: deps.indexRepo,
			indexNote: deps.indexNote,
		});
	}

	synchronizeIndex: SynchronizeIndexUseCase = async () => {
		if (this.isUnloaded) return;

		const run = async (): Promise<void> => {
			if (this.isUnloaded) return;

			try {
				const plan = await this.deps.buildIndexSyncPlan();
				await this.applySyncPlan(plan);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.worker.markFatalError(message);
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

		const settings = await this.deps.settingsRepo.get();
		// TODO: is this even possible / worth considering? This should probably be a invariant handler somewhere
		if (isPathIgnored(noteId, settings.ignoredPaths)) {
			this.worker.removeQueued([noteId]);
			await this.deps.indexRepo.remove(noteId);
			return;
		}

		this.worker.bump(noteId);
	};

	subscribeIndexingState: SubscribeIndexingStateUseCase = (listener) => {
		if (this.isUnloaded) return () => {};
		return this.worker.subscribeQueueSnapshot(listener);
	};

	getSnapshot: GetIndexingStateUseCase = () => this.worker.getSnapshot();

	unload = () => {
		this.isUnloaded = true;
		this.refreshChain = Promise.resolve();
		this.worker.unload();
	};

	private async applySyncPlan(plan: IndexSyncPlan) {
		for (const noteId of plan.idsToRemoveFromIndex) {
			await this.deps.indexRepo.remove(noteId);
		}

		this.worker.enqueue(plan.idsToSeed);
	}
}

export function makeIndexingCoordinator(deps: IndexingCoordinatorDeps): IndexingCoordinator {
	return new IndexingCoordinator(deps);
}

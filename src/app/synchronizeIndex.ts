import { IndexRepository } from "../ports";
import { BuildIndexSyncPlanUseCase, IndexSyncPlan } from "./buildIndexSyncPlan";
import { IndexingWorker } from "./indexingWorker";

export type SynchronizeIndexUseCase = () => Promise<void>;

type SynchronizeIndexDeps = {
	indexRepo: IndexRepository;
	buildIndexSyncPlan: BuildIndexSyncPlanUseCase;
	worker: IndexingWorker;
};

export function makeSynchronizeIndex(deps: SynchronizeIndexDeps): SynchronizeIndexUseCase {
	let running: Promise<void> | null = null;
	let restartRequested = false;

	async function run(): Promise<void> {
		do {
			restartRequested = false;
			try {
				const plan = await deps.buildIndexSyncPlan();
				await applyPlan(plan);
			} catch (error) {
				console.error("[Similarity] Failed to refresh indexing queue:", error);
			}
		} while (restartRequested);
	}

	async function applyPlan(plan: IndexSyncPlan) {
		for (const noteId of plan.idsToRemoveFromIndex) {
			await deps.indexRepo.remove(noteId);
		}

		deps.worker.setBacklog(plan.idsToSeed);
		await deps.worker.whenDrained();
	}

	return function synchronizeIndex(): Promise<void> {
		if (running) {
			restartRequested = true;
			return running;
		}
		running = run().finally(() => {
			running = null;
		});
		return running;
	};
}

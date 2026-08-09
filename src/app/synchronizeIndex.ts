import { IndexRepository } from "../ports";
import { IndexNoteUseCase } from "./indexNote";
import { BuildIndexSyncPlanUseCase, IndexSyncPlan } from "./buildIndexSyncPlan";
import { IndexingProgress } from "./indexingProgress";

export type SynchronizeIndexUseCase = () => Promise<void>;

type SynchronizeIndexDeps = {
	indexRepo: IndexRepository;
	indexNote: IndexNoteUseCase;
	buildIndexSyncPlan: BuildIndexSyncPlanUseCase;
	progress: IndexingProgress
};

export function makeSynchronizeIndex(deps: SynchronizeIndexDeps): SynchronizeIndexUseCase {
	let inFlight: Promise<void> | null = null;

	async function run(): Promise<void> {
		try {
			const plan = await deps.buildIndexSyncPlan()
			await applyPlan(plan);
		} catch (error) {
			console.error("[Similarity] Failed to refresh indexing queue:", error);
		}
	}

	async function applyPlan(plan: IndexSyncPlan) {
		for (const noteId of plan.idsToRemoveFromIndex) {
			await deps.indexRepo.remove(noteId);
		}

		deps.progress.watchAll(plan.idsToSeed);
		const jobs = plan.idsToSeed.map((noteId) =>
			deps.progress.track(noteId, () => deps.indexNote(noteId, "low")),
		);
		await Promise.allSettled(jobs);
	}

	return async function synchronizeIndex() {
		if (inFlight) return await inFlight;

		inFlight = run().finally(() => {
			inFlight = null;
		});
		return await inFlight;
	};
}

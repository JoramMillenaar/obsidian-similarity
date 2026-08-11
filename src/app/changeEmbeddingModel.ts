import { EmbeddingModelId } from "../types";
import { SettingsRepository, StatusReporter } from "../ports";
import { EmbeddingService } from "./embeddingService";
import { SynchronizeIndexUseCase } from "./synchronizeIndex";
import { IndexingWorker } from "./indexingWorker";
import { ThrottledIndexStorage } from "../domain/throttledIndexStorage";
import { ModelSession } from "../domain/modelSession";

export type ChangeEmbeddingModelUseCase = (modelId: EmbeddingModelId) => Promise<void>;

type ChangeEmbeddingModelDeps = {
	embeddingService: EmbeddingService;
	worker: IndexingWorker;
	settingsRepo: SettingsRepository;
	indexStorage: ThrottledIndexStorage;
	synchronizeIndex: SynchronizeIndexUseCase;
	status: StatusReporter;
	modelSession: ModelSession;
};

export function makeChangeEmbeddingModel(deps: ChangeEmbeddingModelDeps): ChangeEmbeddingModelUseCase {
	return async function changeEmbeddingModel(modelId: EmbeddingModelId): Promise<void> {
		if (deps.modelSession.current() === modelId) return;

		// Queued work is just note ids, so there is nothing to cancel across a
		// swap — pausing until the one note in flight settles is enough, and the
		// rest simply get indexed with the new model once we resume.
		// TODO: possible false assumption. What is indexed changes completely after swapping since it will use a different storage destination. Models have a dedicated index
		await deps.worker.pause();

		try {
			await deps.modelSession.transition(modelId, async () => {
				await deps.settingsRepo.updatePartial({embeddingModelId: modelId});
				deps.status.update(`Loading ${modelId} model…`);

				await deps.embeddingService.swap(modelId);

				await deps.indexStorage.repair(modelId);
			});
		} catch (error) {
			// The old model is already torn down and the new one did not come up,
			// so drop queued work instead of resuming against a dead embedder.
			await deps.worker.reset();
			await deps.settingsRepo.updatePartial({embeddingModelId: deps.modelSession.current()}).catch(() => undefined);
			deps.status.update(`Failed to switch to ${modelId}.`, 4000);
			throw error;
		} finally {
			deps.worker.resume();
		}

		deps.status.update(`Switched to ${modelId}.`, 4000);

		void deps.synchronizeIndex();
	}
}

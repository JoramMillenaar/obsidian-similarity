import { EmbeddingModelId } from "../types";
import { EmbeddingPort, SettingsRepository, StatusReporter } from "../ports";
import { EMBEDDING_MODELS } from "../constants";
import { SynchronizeIndexUseCase } from "./synchronizeIndex";
import { IndexingWorker } from "./indexingWorker";
import { ThrottledIndexStorage } from "../domain/throttledIndexStorage";
import { ModelSession } from "../domain/modelSession";

export type ChangeEmbeddingModelUseCase = (modelId: EmbeddingModelId) => Promise<void>;

type ChangeEmbeddingModelDeps = {
	embedder: EmbeddingPort;
	worker: IndexingWorker;
	settingsRepo: SettingsRepository;
	indexStorage: ThrottledIndexStorage;
	synchronizeIndex: SynchronizeIndexUseCase;
	status: StatusReporter;
	modelSession: ModelSession;
};

export function makeChangeEmbeddingModel(deps: ChangeEmbeddingModelDeps): ChangeEmbeddingModelUseCase {
	return async function changeEmbeddingModel(modelId: EmbeddingModelId): Promise<void> {
		const previousModelId = deps.modelSession.current();
		if (previousModelId === modelId) return;

		await deps.worker.pause();

		try {
			await deps.modelSession.transition(modelId, async () => {
				await deps.settingsRepo.updatePartial({embeddingModelId: modelId});
				deps.status.update(`Loading ${EMBEDDING_MODELS[modelId].label} model…`);

				deps.embedder.unload();
				const loadStartedAt = Date.now();
				await deps.embedder.load(EMBEDDING_MODELS[modelId], (progress) => {
					if (Date.now() - loadStartedAt < 1000) return;
					deps.status.update(`Downloading ${EMBEDDING_MODELS[modelId].label} model… ${Math.round(progress.progress)}%`);
				});

				await deps.indexStorage.repair(modelId);
			});
		} catch (error) {
			await deps.settingsRepo.updatePartial({embeddingModelId: previousModelId}).catch(() => undefined);

			await deps.embedder.load(EMBEDDING_MODELS[previousModelId]).catch((restoreError) => {
				console.error(
					`[Similarity] Could not restore the ${previousModelId} model after a failed switch:`,
					restoreError,
				);
			});

			deps.status.update(`Failed to switch to ${EMBEDDING_MODELS[modelId].label}.`, 4000);
			throw error;
		} finally {
			await deps.worker.reset();
			deps.worker.resume();
		}

		deps.status.update(`Switched to ${EMBEDDING_MODELS[modelId].label}.`, 4000);

		void deps.synchronizeIndex();
	}
}

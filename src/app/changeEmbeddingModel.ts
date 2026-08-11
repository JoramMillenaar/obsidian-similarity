import { EmbeddingModelId } from "../types";
import { SettingsRepository, StatusReporter } from "../ports";
import { EmbeddingService } from "./embeddingService";
import { SynchronizeIndexUseCase } from "./synchronizeIndex";
import { ThrottledIndexStorage } from "../domain/throttledIndexStorage";
import { ModelSession } from "../domain/modelSession";

export type ChangeEmbeddingModelUseCase = (modelId: EmbeddingModelId) => Promise<void>;

type ChangeEmbeddingModelDeps = {
	embeddingService: EmbeddingService;
	settingsRepo: SettingsRepository;
	indexStorage: ThrottledIndexStorage;
	synchronizeIndex: SynchronizeIndexUseCase;
	status: StatusReporter;
	modelSession: ModelSession;
};

export function makeChangeEmbeddingModel(deps: ChangeEmbeddingModelDeps): ChangeEmbeddingModelUseCase {
	async function rebuild(): Promise<void> {
		try {
			await deps.synchronizeIndex().catch(() => undefined);
			await deps.synchronizeIndex();
		} catch (error) {
			console.error("[Similarity] Reindex after model change failed:", error);
		}
	}

	return async function changeEmbeddingModel(modelId: EmbeddingModelId): Promise<void> {
		if (deps.modelSession.current() === modelId) return;

		try {
			await deps.modelSession.transition(modelId, async () => {
				await deps.settingsRepo.updatePartial({embeddingModelId: modelId});
				deps.status.update(`Loading ${modelId} model…`);

				await deps.embeddingService.swap(modelId);

				await deps.indexStorage.repair(modelId);
			});
		} catch (error) {
			await deps.settingsRepo.updatePartial({embeddingModelId: deps.modelSession.current()}).catch(() => undefined);
			deps.status.update(`Failed to switch to ${modelId}.`, 4000);
			throw error;
		}

		deps.status.update(`Switched to ${modelId}.`, 4000);

		void rebuild();
	}
}

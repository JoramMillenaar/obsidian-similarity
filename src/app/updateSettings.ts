import { SimilaritySettings } from "../types";
import { IndexStorage, SettingsRepository } from "../ports";
import { ModelNotReadyError, ModelSession } from "./modelSession";

export type UpdateSettingsUseCase = (patch: Partial<SimilaritySettings>) => Promise<void>;

export function makeUpdateSettings(deps: {
	settingsRepo: SettingsRepository;
	indexStorage: IndexStorage;
	modelSession: ModelSession;
}): UpdateSettingsUseCase {
	return async function updateSettings(patch) {
		const {embeddingModelId, ...rest} = patch;

		if (Object.keys(rest).length > 0) {
			await deps.settingsRepo.updatePartial(rest);
		}

		if (embeddingModelId !== undefined) {
			await deps.modelSession.requestModel(embeddingModelId);
			return;
		}

		try {
			await deps.modelSession.withGeneration(async (generation) => {
				await deps.indexStorage.repair(generation.modelId);
				void generation.synchronizeIndex();
			});
		} catch (error) {
			if (!(error instanceof ModelNotReadyError)) throw error;
		}
	};
}

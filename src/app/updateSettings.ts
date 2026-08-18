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
			// The settings above are already persisted, so this is not a failed save: there is simply
			// no model to repair or resync against yet. Whichever load is pending does both when it lands.
			if (!(error instanceof ModelNotReadyError)) throw error;
		}
	};
}

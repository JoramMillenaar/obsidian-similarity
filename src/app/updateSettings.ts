import { SimilaritySettings } from "../types";
import { IndexStorage, SettingsRepository } from "../ports";
import { SynchronizeIndexUseCase } from "./synchronizeIndex";
import { ModelSession } from "../domain/modelSession";

export type UpdateSettingsUseCase = (
	patch: Partial<Omit<SimilaritySettings, "embeddingModelId">>,
) => Promise<void>;

export function makeUpdateSettings(deps: {
	settingsRepo: SettingsRepository;
	indexStorage: IndexStorage;
	synchronizeIndex: SynchronizeIndexUseCase;
	modelSession: ModelSession;
}): UpdateSettingsUseCase {
	return async function updateSettings(patch) {
		await deps.settingsRepo.updatePartial(patch);

		// Now we need to make sure the index reflects the updated settings.
		await deps.indexStorage.repair(deps.modelSession.current());
		await deps.synchronizeIndex();
	};
}

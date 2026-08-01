import { SimilaritySettings } from "../types";
import { IndexStorage, SettingsRepository } from "../ports";
import { SynchronizeIndexUseCase } from "./synchronizeIndex";

export type UpdateSettingsUseCase = (
	patch: Partial<SimilaritySettings>,
) => Promise<void>;

export function makeUpdateSettings(deps: {
	settingsRepo: SettingsRepository;
	indexStorage: IndexStorage;
	synchronizeIndex: SynchronizeIndexUseCase;
}): UpdateSettingsUseCase {
	return async function updateSettings(patch) {
		await deps.settingsRepo.updatePartial(patch);

		// Now we need to make sure the index reflects the updated settings.
		await deps.indexStorage.repair();
		await deps.synchronizeIndex();
	};
}

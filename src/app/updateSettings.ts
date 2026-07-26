import { SimilaritySettings } from "../types";
import { SettingsRepository } from "../ports";
import { SynchronizeIndexUseCase } from "./indexingCoordinator";

export type UpdateSettingsResult = {
	reindexQueued: boolean;
};

export type UpdateSettingsUseCase = (
	patch: Partial<SimilaritySettings>,
) => Promise<UpdateSettingsResult>;

export function makeUpdateSettings(deps: {
	settingsRepo: SettingsRepository;
	indexStorage: { isEmpty: () => Promise<boolean> };
	synchronizeIndex: SynchronizeIndexUseCase;
}): UpdateSettingsUseCase {
	return async function updateSettings(patch) {
		await deps.settingsRepo.updatePartial(patch);
		if (await deps.indexStorage.isEmpty()) {
			return {reindexQueued: false};
		}

		await deps.synchronizeIndex({
			awaitCompletion: false,
			forceReindexAll: true,
		});
		return {reindexQueued: true};
	};
}

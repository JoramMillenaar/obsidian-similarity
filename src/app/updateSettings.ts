import { SimilaritySettings } from "../types";
import { SettingsRepository } from "../ports";
import { SynchronizeIndexUseCase } from "./indexSyncWorker";

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
		// TODO: before we reindexed everything on setting change. Should we just keep this simple and make the self-heal bulletproof?
		await deps.synchronizeIndex();
		return {reindexQueued: true};
	};
}

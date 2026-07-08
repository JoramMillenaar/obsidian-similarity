import { IndexBackend, SimilaritySettings } from "../types";
import { SettingsRepository } from "../ports";
import { StartOrRefreshIndexSyncUseCase } from "./indexingCoordinator";
import { MigrateIndexBackendUseCase } from "./migrateIndexBackend";

export type UpdateSettingsResult = {
	reindexQueued: boolean;
	backendMigrated: boolean;
};

export type UpdateSettingsUseCase = (
	patch: Partial<SimilaritySettings>,
) => Promise<UpdateSettingsResult>;

export function makeUpdateSettings(deps: {
	settingsRepo: SettingsRepository;
	indexStorage: { isEmpty: () => Promise<boolean> };
	startOrRefreshIndexSync: StartOrRefreshIndexSyncUseCase;
	migrateIndexBackend: MigrateIndexBackendUseCase;
	getActiveBackend: () => IndexBackend;
}): UpdateSettingsUseCase {
	return async function updateSettings(patch) {
		const backendChanged =
			patch.indexBackend !== undefined && patch.indexBackend !== deps.getActiveBackend();

		await deps.settingsRepo.updatePartial(patch);

		if (backendChanged) {
			// Move the existing index across to the new backend rather than
			// discarding and re-embedding it from scratch.
			await deps.migrateIndexBackend(patch.indexBackend as IndexBackend);
			return {reindexQueued: false, backendMigrated: true};
		}

		if (await deps.indexStorage.isEmpty()) {
			return {reindexQueued: false, backendMigrated: false};
		}

		await deps.startOrRefreshIndexSync({
			awaitCompletion: false,
			forceReindexAll: true,
		});
		return {reindexQueued: true, backendMigrated: false};
	};
}

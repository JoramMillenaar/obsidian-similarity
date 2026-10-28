import { SimilaritySettings } from "../types";
import { SettingsRepository } from "../ports";

export type UpdateSettingsUseCase = (patch: Partial<SimilaritySettings>) => Promise<void>;

export function makeUpdateSettings(deps: {
	settingsRepo: SettingsRepository;
	resync: () => Promise<void>;
}): UpdateSettingsUseCase {
	return async function updateSettings(patch) {
		await deps.settingsRepo.updatePartial(patch);
		void deps.resync();
	};
}

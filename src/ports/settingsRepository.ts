import { SimilaritySettings } from "../types";

export interface SettingsRepository {
	get(): SimilaritySettings;

	updatePartial(patch: Partial<SimilaritySettings>): Promise<void>;
}

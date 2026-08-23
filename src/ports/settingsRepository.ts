import { SimilaritySettings } from "../types";

export interface SettingsRepository {
	get(): SimilaritySettings;

	update(settings: SimilaritySettings): Promise<void>;

	updatePartial(patch: Partial<SimilaritySettings>): Promise<void>;
}

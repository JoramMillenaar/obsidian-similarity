import { SimilaritySettings } from "../../types";
import { SettingsRepository } from "../../ports";
import { DEFAULT_SETTINGS } from "../../constants";
import { ObsidianPluginDataStore } from "./obsidianPluginDataStore";

export class ObsidianSettingsRepository implements SettingsRepository {
	constructor(private readonly store: ObsidianPluginDataStore) {
	}

	get(): SimilaritySettings {
		const cached = this.store.getCached();
		if (cached) return cached.settings;

		console.warn("[Similarity] SettingsRepository.get() called before the plugin data store finished loading — using defaults.");
		return DEFAULT_SETTINGS;
	}

	async update(settings: SimilaritySettings): Promise<void> {
		return this.writeSettings(() => settings);
	}

	async updatePartial(patch: Partial<SimilaritySettings>): Promise<void> {
		return this.writeSettings((current) => ({
			...current,
			...patch,
		}));
	}

	private async writeSettings(
		update: (current: SimilaritySettings) => SimilaritySettings,
	): Promise<void> {
		const next = update(this.get());
		await this.store.write({settings: next});
	}
}

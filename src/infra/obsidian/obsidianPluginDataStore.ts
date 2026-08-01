import { Plugin } from "obsidian";
import { SimilarityPluginData } from "../../types";
import { PluginDataStore } from "../../ports";
import { normalizePluginData } from "../../domain/normalize";

export class ObsidianPluginDataStore implements PluginDataStore {
	constructor(private readonly plugin: Plugin) {
	}

	async read(): Promise<SimilarityPluginData> {
		const raw = (await this.plugin.loadData() as Partial<SimilarityPluginData> | null) ?? {};
		return normalizePluginData(raw);
	}

	async write(data: SimilarityPluginData): Promise<void> {
		await this.plugin.saveData(data);
	}

	async update(
		updater: (current: SimilarityPluginData) => SimilarityPluginData,
	): Promise<SimilarityPluginData> {
		const current = await this.read();
		const next = updater(current);
		await this.write(next);
		return next;
	}
}

import { Plugin } from "obsidian";
import { SimilarityPluginData } from "../../types";
import { PluginDataStore } from "../../ports";
import { normalizePluginData } from "../../domain/normalize";

export class ObsidianPluginDataStore implements PluginDataStore {
	constructor(private readonly plugin: Plugin) {
	}

	async read(): Promise<SimilarityPluginData> {
		return normalizePluginData(await this.readRaw());
	}

	async readRaw(): Promise<Record<string, unknown>> {
		return (await this.plugin.loadData() as Record<string, unknown> | null) ?? {};
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

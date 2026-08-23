import { Plugin } from "obsidian";
import { SimilarityPluginData } from "../../types";
import { PluginDataStore } from "../../ports";
import { normalizePluginData } from "../../domain/normalize";


export class ObsidianPluginDataStore implements PluginDataStore {
	private cache: SimilarityPluginData | null = null;

	constructor(private readonly plugin: Plugin) {
	}

	async load(): Promise<SimilarityPluginData> {
		this.cache = normalizePluginData(await this.readRaw());
		return this.cache;
	}

	getCached(): SimilarityPluginData | null {
		return this.cache;
	}

	async read(): Promise<SimilarityPluginData> {
		if (this.cache) return this.cache;
		return this.load();
	}

	async readRaw(): Promise<Record<string, unknown>> {
		return (await this.plugin.loadData() as Record<string, unknown> | null) ?? {};
	}

	async write(data: SimilarityPluginData): Promise<void> {
		this.cache = data;
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

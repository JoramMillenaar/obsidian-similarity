import { SimilarityPluginData } from "../types";

export interface PluginDataStore {
	read(): Promise<SimilarityPluginData>;

	write(data: SimilarityPluginData): Promise<void>;

	update(
		updater: (current: SimilarityPluginData) => SimilarityPluginData,
	): Promise<SimilarityPluginData>;

	readRaw(): Promise<Record<string, unknown>>;
}

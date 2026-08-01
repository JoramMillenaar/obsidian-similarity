import { SimilarityPluginData } from "../types";

/**
 * Read/write access to the plugin's JSON data blob (Obsidian's data.json).
 * Reads always return normalized data; writes persist it verbatim. Kept as a
 * port so the storage adapter — and its migration path — can run against an
 * in-memory fake with no Obsidian dependency.
 */
export interface PluginDataStore {
	read(): Promise<SimilarityPluginData>;

	write(data: SimilarityPluginData): Promise<void>;

	update(
		updater: (current: SimilarityPluginData) => SimilarityPluginData,
	): Promise<SimilarityPluginData>;
}

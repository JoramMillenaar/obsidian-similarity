import { SimilarityPluginData } from "../types";

export interface PluginDataStore {
	write(data: SimilarityPluginData): Promise<void>;

	readRaw(): Promise<Record<string, unknown>>;
}

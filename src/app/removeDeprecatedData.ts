import { EmbeddingFileStore, ModelIndexMetaStore, PluginDataStore } from "../ports";
import { normalizeSettings } from "../core/rules/schema";
import { SimilaritySettings } from "../types";
import { DEPRECATED_MODEL_IDS } from "../constants";

export type RemoveDeprecatedDataUseCase = () => Promise<void>;

type RemoveDeprecatedDataDeps = {
	pluginDataStore: PluginDataStore;
	modelIndexStore: ModelIndexMetaStore;
	embeddingFileStore: EmbeddingFileStore;
	legacyEmbeddingFileStore: {remove(): Promise<boolean>};
};

const LEGACY_DATA_KEYS = ["schemaVersion", "embeddingDim", "index"];

export function makeRemoveDeprecatedData(deps: RemoveDeprecatedDataDeps): RemoveDeprecatedDataUseCase {
	return async function removeDeprecatedData() {
		await attempt("the pre-v2 index metadata", () => dropLegacyData(deps.pluginDataStore));
		await attempt("the pre-v2 index", () => deps.legacyEmbeddingFileStore.remove());
		for (const modelId of DEPRECATED_MODEL_IDS) {
			await attempt(`the deprecated ${modelId} index`, async () => {
				const removedMeta = await deps.modelIndexStore.remove(modelId);
				const removedVectors = await deps.embeddingFileStore.remove(modelId);
				return removedMeta || removedVectors;
			});
		}
	};
}

async function dropLegacyData(store: PluginDataStore): Promise<boolean> {
	const raw = await store.readRaw();
	if (!LEGACY_DATA_KEYS.some((key) => key in raw)) return false;

	const settings = isRecord(raw.settings) ? raw.settings : {};
	await store.write({settings: normalizeSettings(settings as Partial<SimilaritySettings>)});
	return true;
}

async function attempt(what: string, remove: () => Promise<boolean>): Promise<void> {
	try {
		if (await remove()) console.info(`[Similarity] Removed ${what}.`);
	} catch (error) {
		console.warn(`[Similarity] Could not remove ${what}; will retry on the next start.`, error);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

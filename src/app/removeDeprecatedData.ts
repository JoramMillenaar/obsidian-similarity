import { EmbeddingFileStore, ModelIndexMetaStore, PluginDataStore } from "../ports";
import { normalizeSettings } from "../core/rules/schema";
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
				await deps.modelIndexStore.remove(modelId);
				await deps.embeddingFileStore.remove(modelId);
			});
		}
	};
}

async function dropLegacyData(store: PluginDataStore): Promise<void> {
	const raw = await store.readRaw();
	if (!LEGACY_DATA_KEYS.some((key) => key in raw)) return;

	const settings = isRecord(raw.settings) ? raw.settings : {};
	await store.write({settings: normalizeSettings(settings)});
}

async function attempt(what: string, remove: () => Promise<unknown>): Promise<void> {
	try {
		await remove();
	} catch (error) {
		console.warn(`[Similarity] Could not remove ${what}; will retry on the next start.`, error);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

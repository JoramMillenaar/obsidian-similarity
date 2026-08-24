import { EmbeddingFileStore, ModelIndexMetaStore, PluginDataStore } from "../ports";
import { normalizeSettings } from "../core/rules/schema";
import { IndexMetadata, SCHEMA_VERSION, SimilaritySettings } from "../types";
import { LegacyEmbeddingFileStore } from "../obsidian/legacyEmbeddingFileStore";


export type RunLegacyMigrationsUseCase = () => Promise<void>;

type LegacyMigrationsDeps = {
	pluginDataStore: PluginDataStore;
	modelIndexStore: ModelIndexMetaStore;
	embeddingFileStore: EmbeddingFileStore;
	legacyEmbeddingFileStore: LegacyEmbeddingFileStore;
};

export function makeRunLegacyMigrations(deps: LegacyMigrationsDeps): RunLegacyMigrationsUseCase {
	return async function runLegacyMigrations() {
		const raw = await deps.pluginDataStore.readRaw();
		if (!("schemaVersion" in raw) && !("embeddingDim" in raw) && !("index" in raw)) return;

		const legacySchemaVersion = typeof raw.schemaVersion === "number" ? raw.schemaVersion : 1;
		const legacyIndex: IndexMetadata = Array.isArray(raw.index) ? raw.index as IndexMetadata : [];
		const legacyDim = typeof raw.embeddingDim === "number" ? raw.embeddingDim : 0;
		const settings = normalizeSettings(raw.settings as Partial<SimilaritySettings> | undefined);

		if (legacySchemaVersion >= SCHEMA_VERSION && legacyIndex.length > 0) {
			const buffer = await deps.legacyEmbeddingFileStore.read();
			const alreadyMigrated = buffer && await deps.modelIndexStore.read(settings.embeddingModelId);

			if (buffer && !alreadyMigrated) {
				console.warn(`[Similarity] Migrating legacy index into per-model files for "${settings.embeddingModelId}".`);
				await deps.embeddingFileStore.write(settings.embeddingModelId, buffer);
				await deps.modelIndexStore.write(settings.embeddingModelId, {
					schemaVersion: legacySchemaVersion,
					embeddingDim: legacyDim,
					index: legacyIndex,
				});
			}
		}

		await deps.legacyEmbeddingFileStore.remove();
		await deps.pluginDataStore.write({settings});
	};
}

import { PluginDataStore } from "../ports";

const CHUNKED_INDEX_SCHEMA_VERSION = 2;

export type LegacyMigration = (store: PluginDataStore) => Promise<void>;

const dropPreV2Index: LegacyMigration = async (store) => {
	const data = await store.read();
	if (data.schemaVersion >= CHUNKED_INDEX_SCHEMA_VERSION) return;

	console.warn("[Similarity] Discarding legacy (pre-v2) index; it will be rebuilt.");
	await store.update((current) => ({
		...current,
		schemaVersion: CHUNKED_INDEX_SCHEMA_VERSION,
		embeddingDim: 0,
		index: [],
	}));
};

const LEGACY_MIGRATIONS: readonly LegacyMigration[] = [
	dropPreV2Index,
];

export async function runLegacyMigrations(store: PluginDataStore): Promise<void> {
	for (const migration of LEGACY_MIGRATIONS) {
		await migration(store);
	}
}

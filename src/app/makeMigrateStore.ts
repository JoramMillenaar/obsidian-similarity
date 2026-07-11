import { IndexStorage } from "../ports";

export type MigrateStoreUseCase = () => Promise<void>;

/**
 * One-time, idempotent workflow: moves inline float64 embeddings into the
 * binary sidecar. Deliberately takes no EmbeddingPort dependency — migration
 * can only repack embeddings that already exist, never recompute them.
 */
export function makeMigrateStore(deps: {
	indexStorage: IndexStorage;
}): MigrateStoreUseCase {
	return async function migrateStore(): Promise<void> {
		const legacy = await deps.indexStorage.readLegacy();
		if (!legacy || legacy.length === 0) return;

		await deps.indexStorage.rewrite(legacy);
		await deps.indexStorage.flush();
	};
}

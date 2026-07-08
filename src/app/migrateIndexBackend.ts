import { IndexBackend } from "../types";
import { SwitchableIndexStorage } from "../infra/index/switchableIndexStorage";

export type MigrateIndexBackendUseCase = (target: IndexBackend) => Promise<void>;

/**
 * Moves the persisted index from the currently active backend to `target`,
 * then makes `target` active. The source is cleared afterwards so the index
 * lives in exactly one place ("move", not "copy").
 */
export function makeMigrateIndexBackend(deps: {
	storage: SwitchableIndexStorage;
}): MigrateIndexBackendUseCase {
	return async function migrateIndexBackend(target) {
		const source = deps.storage.getActive();
		if (source === target) return;

		const sourceStorage = deps.storage.storageFor(source);
		const targetStorage = deps.storage.storageFor(target);

		const notes = await sourceStorage.getAll();
		await targetStorage.rewrite(notes);

		deps.storage.setActive(target);

		await sourceStorage.rewrite([]);
	};
}

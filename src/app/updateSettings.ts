import { SimilaritySettings } from "../types";
import { SettingsRepository } from "../ports";
import { StartOrRefreshIndexSyncUseCase } from "./indexingCoordinator";
import { CollapseIndexToAverageUseCase } from "./collapseIndexToAverage";

export type UpdateSettingsResult = {
	reindexQueued: boolean;
};

export type UpdateSettingsUseCase = (
	patch: Partial<SimilaritySettings>,
) => Promise<UpdateSettingsResult>;

/** Settings whose change requires re-embedding the vault to take effect. */
const EMBEDDING_AFFECTING_KEYS: (keyof SimilaritySettings)[] = [
	"ignoredPaths",
	"maxRawMarkdownChars",
	"maxExtractedChars",
	"maxChunks",
	"overlap",
];

function hasEmbeddingAffectingChange(
	previous: SimilaritySettings,
	patch: Partial<SimilaritySettings>,
): boolean {
	return EMBEDDING_AFFECTING_KEYS.some((key) => {
		if (!(key in patch)) return false;
		const before = previous[key];
		const after = patch[key];
		if (Array.isArray(before) || Array.isArray(after)) {
			return JSON.stringify(before) !== JSON.stringify(after);
		}
		return before !== after;
	});
}

export function makeUpdateSettings(deps: {
	settingsRepo: SettingsRepository;
	indexStorage: { isEmpty: () => Promise<boolean> };
	startOrRefreshIndexSync: StartOrRefreshIndexSyncUseCase;
	collapseIndexToAverage: CollapseIndexToAverageUseCase;
}): UpdateSettingsUseCase {
	return async function updateSettings(patch) {
		const previous = await deps.settingsRepo.get();
		await deps.settingsRepo.updatePartial(patch);

		if (await deps.indexStorage.isEmpty()) {
			return {reindexQueued: false};
		}

		const optingIn = !previous.storeAllChunks && patch.storeAllChunks === true;
		const optingOut = previous.storeAllChunks && patch.storeAllChunks === false;
		const embeddingChanged = hasEmbeddingAffectingChange(previous, patch);

		// Opting out is cheap: average existing chunk vectors in place, no reindex.
		if (optingOut && !embeddingChanged) {
			await deps.collapseIndexToAverage();
			return {reindexQueued: false};
		}

		if (optingIn || embeddingChanged) {
			await deps.startOrRefreshIndexSync({
				awaitCompletion: false,
				forceReindexAll: true,
			});
			return {reindexQueued: true};
		}

		// Nothing that affects embeddings changed (e.g. dismissing the migration banner).
		return {reindexQueued: false};
	};
}

import { isPathIgnored } from "../domain/ignoreRules";
import { IndexRepository, NoteSource, SettingsRepository } from "../ports";

import { sortIndexCandidates } from "../domain/sortIndexCandidates";

export type IndexSyncPlan = {
	idsToRemoveFromIndex: string[];
	idsToSeed: string[];
};

export type BuildIndexSyncPlanUseCase = () => Promise<IndexSyncPlan>;

export function makeBuildIndexSyncPlan(deps: {
	noteSource: NoteSource;
	indexRepo: IndexRepository;
	settingsRepo: SettingsRepository;
}): BuildIndexSyncPlanUseCase {
	return async function buildIndexSyncPlan() {
		const settings = await deps.settingsRepo.get();
		const candidates = deps.noteSource
			.listIndexCandidates()
			.filter((candidate) => !isPathIgnored(candidate.id, settings.ignoredPaths));
		const candidateIds = new Set(candidates.map((candidate) => candidate.id));

		const index = await deps.indexRepo.listAll();
		const indexedById = new Map(index.map((entry) => [entry.id, entry]));

		const idsToRemoveFromIndex = index
			.map((entry) => entry.id)
			.filter((id) => !candidateIds.has(id));

		// A candidate needs (re-)seeding when it has no index entry yet, or its
		// file was modified after it was last indexed. `indexNote`'s content-hash
		// check is the backstop if mtime is wrong or imprecise — worst case a
		// note is re-seeded and turns out unchanged, which is cheap.
		const staleCandidates = candidates.filter((candidate) => {
			const indexed = indexedById.get(candidate.id);
			if (!indexed) return true;
			return candidate.modifiedAt > new Date(indexed.updatedAt).getTime();
		});

		return {
			idsToRemoveFromIndex,
			idsToSeed: sortIndexCandidates(staleCandidates),
		};
	};
}

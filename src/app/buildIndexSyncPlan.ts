import { deriveSyncActions } from "../domain/getSyncActions";
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
		const allCandidates = deps.noteSource.listIndexCandidates();
		const candidates = allCandidates.filter(
			(candidate) => !isPathIgnored(candidate.id, settings.ignoredPaths),
		);
		const candidateMap = new Map(candidates.map((candidate) => [candidate.id, candidate]));
		const index = await deps.indexRepo.listAll();
		const indexedIds = index.map((entry) => entry.id);
		const actions = deriveSyncActions(
			candidates.map((candidate) => candidate.id),
			indexedIds,
		);
		const idsToSeed = sortIndexCandidates(
			[...new Set(actions.toAdd)]
				.map((noteId) => candidateMap.get(noteId))
				.filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate)),
		);

		return {
			idsToRemoveFromIndex: [...new Set(actions.toRemove)],
			idsToSeed,
		};
	};
}

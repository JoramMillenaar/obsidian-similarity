import { isPathIgnored } from "../core/rules/ignorePaths";
import { SettingsRepository, Vault } from "../ports";
import { sortIndexCandidates } from "../core/rules/candidates";
import { IndexHandle } from "./store/indexHandle";

export type IndexSyncPlan = {
	idsToRemoveFromIndex: string[];
	idsToSeed: string[];
};

export type BuildIndexSyncPlanUseCase = () => IndexSyncPlan;

export function makeBuildIndexSyncPlan(deps: {
	vault: Vault;
	index: IndexHandle;
	settingsRepo: SettingsRepository;
}): BuildIndexSyncPlanUseCase {
	return function buildIndexSyncPlan() {
		const settings = deps.settingsRepo.get();
		const candidates = deps.vault
			.listIndexCandidates()
			.filter((candidate) => !isPathIgnored(candidate.id, settings.ignoredPaths));
		const candidateIds = new Set(candidates.map((candidate) => candidate.id));

		const entries = deps.index.entries();
		const indexedById = new Map(entries.map((entry) => [entry.id, entry]));

		const idsToRemoveFromIndex = entries
			.map((entry) => entry.id)
			.filter((id) => !candidateIds.has(id));

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

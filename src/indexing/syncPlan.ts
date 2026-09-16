import { isPathIgnored } from "../core/rules/ignorePaths";
import { SettingsRepository, Vault } from "../ports";
import { sortIndexCandidates } from "../core/rules/candidates";
import { IndexHandle } from "./store/indexHandle";

export type IndexSyncPlan = {
	idsToRemoveFromIndex: string[];
	idsToSeed: string[];
};

export type BuildIndexSyncPlanUseCase = () => IndexSyncPlan;

/**
 * How close a note's last chunk needs to sit to a previous character cap to be treated as
 * "possibly truncated by it". The chunker's sentence-boundary packing can end a chunk somewhat
 * short of the exact cap (a trailing partial sentence is dropped rather than split), so an exact
 * equality check would miss genuinely truncated notes.
 */
const TRUNCATION_MARGIN_CHARS = 200;

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

		const rawCapIncreased = settings.maxRawMarkdownChars > settings.lastAppliedMaxRawMarkdownChars;
		const extractedCapIncreased = settings.maxExtractedChars > settings.lastAppliedMaxExtractedChars;
		const previousCap = Math.min(settings.lastAppliedMaxRawMarkdownChars, settings.lastAppliedMaxExtractedChars);

		const staleCandidates = candidates.filter((candidate) => {
			const indexed = indexedById.get(candidate.id);
			if (!indexed) return true;
			if (candidate.modifiedAt > new Date(indexed.updatedAt).getTime()) return true;

			// Unmodified since indexing, but a raised character cap may now cover more of a
			// note that previously got cut off right at the old cap.
			if ((rawCapIncreased || extractedCapIncreased) && indexed.lastChunkEnd >= previousCap - TRUNCATION_MARGIN_CHARS) {
				return true;
			}
			return false;
		});

		return {
			idsToRemoveFromIndex,
			idsToSeed: sortIndexCandidates(staleCandidates),
		};
	};
}

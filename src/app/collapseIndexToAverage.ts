import { averageEmbeddings, normalizeEmbedding } from "../domain/embedding";
import { IndexedNote } from "../types";
import { IndexRepository } from "../ports";

export type CollapseIndexToAverageUseCase = () => Promise<void>;

/**
 * Opt-out from per-chunk storage: average each note's chunk vectors down to a
 * single normalized vector in place. Pure data transform — never re-embeds, so
 * it's cheap ("opting out is essentially free"). Notes already holding a single
 * vector are unchanged.
 */
export function makeCollapseIndexToAverage(deps: {
	indexRepo: IndexRepository;
}): CollapseIndexToAverageUseCase {
	return async function collapseIndexToAverage(): Promise<void> {
		const notes = await deps.indexRepo.listAll();

		const collapsed: IndexedNote[] = [];
		for (const note of notes) {
			if (note.embeddings.length <= 1) continue;
			const averaged = averageEmbeddings(note.embeddings);
			if (!averaged) continue;
			collapsed.push({...note, embeddings: [normalizeEmbedding(averaged)]});
		}

		if (collapsed.length > 0) {
			await deps.indexRepo.upsertMany(collapsed);
		}
	};
}

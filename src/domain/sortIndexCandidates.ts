import { NoteIndexCandidate } from "../types";

export function sortIndexCandidates(candidates: NoteIndexCandidate[]): string[] {
	return [...candidates]
		.sort((left, right) => {
			const leftRank = left.recentOpenRank ?? Number.POSITIVE_INFINITY;
			const rightRank = right.recentOpenRank ?? Number.POSITIVE_INFINITY;

			if (leftRank !== rightRank) {
				return leftRank - rightRank;
			}
			if (left.modifiedAt !== right.modifiedAt) {
				return right.modifiedAt - left.modifiedAt;
			}
			return left.id.localeCompare(right.id);
		})
		.map((candidate) => candidate.id);
}

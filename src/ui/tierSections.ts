import { RelatedNote, SimilarityTier } from "../types";

export type TierSection = {
	tier: SimilarityTier;
	items: RelatedNote[];
};

export function groupByTier(items: readonly RelatedNote[]): TierSection[] {
	const sections = new Map<SimilarityTier, RelatedNote[]>();
	for (const item of items) {
		const section = sections.get(item.tier);
		if (section) section.push(item);
		else sections.set(item.tier, [item]);
	}
	return [...sections.entries()]
		.sort(([a], [b]) => b - a)
		.map(([tier, tierItems]) => ({tier, items: tierItems}));
}

import { SimilarityTier, TierThresholds } from "../../types";

export const SIMILARITY_TIER_LABELS: Record<SimilarityTier, string> = {
	0: "Loosely related",
	1: "Related",
	2: "Closely related",
	3: "Near-identical",
};

export function similarityTier(score: number, thresholds: TierThresholds): SimilarityTier {
	let tier = 0;
	while (tier < thresholds.length && score >= thresholds[tier]) tier++;
	return tier as SimilarityTier;
}

export function scaleScore(score: number, thresholds: TierThresholds): number {
	const tier = similarityTier(score, thresholds);
	const bounds = [0, ...thresholds, 1];
	const lo = bounds[tier];
	const hi = bounds[tier + 1];
	const within = hi > lo ? (score - lo) / (hi - lo) : 1;
	const scaled = (tier + within) / (bounds.length - 1);
	return scaled < 0 ? 0 : scaled > 1 ? 1 : scaled;
}

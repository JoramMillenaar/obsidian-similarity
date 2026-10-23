import { setIcon, setTooltip } from "obsidian";
import { RelatedNote } from "../types";
import { scaleScore, SIMILARITY_TIER_LABELS, similarityTier } from "../core/vector/similarityTier";
import { KEYWORD_MATCH, MATCH_KINDS, RERANKER_MODEL } from "../constants";

/** Shows whether the search's words (keyword), a passage (precise) or the notes as a whole (average) matched. */
export function renderMatchIcon(parent: HTMLElement, note: RelatedNote, cls: string): HTMLElement {
	const kind = note.keyword ? KEYWORD_MATCH : MATCH_KINDS[note.match];
	const icon = parent.createDiv({cls: `similarity-match-icon ${cls}`});
	setIcon(icon, kind.icon);
	setTooltip(icon, `${kind.label}: ${kind.desc}`);
	return icon;
}

/** How close the meaning is, or for a reranked result, how relevant the reranker judged it. */
export function renderSimilarityBar(parent: HTMLElement, note: RelatedNote): HTMLElement {
	const {relevance} = note;
	const thresholds = RERANKER_MODEL.tierThresholds;
	const tier = relevance === undefined ? note.tier : similarityTier(relevance, thresholds);
	const fill = relevance === undefined ? note.scaledScore : scaleScore(relevance, thresholds);

	const bar = parent.createDiv({cls: `similarity-bar similarity-tier-${tier}`});
	bar.createDiv({cls: "similarity-bar-fill"}).setCssProps({"--similarity-fill": `${Math.round(fill * 100)}%`});
	setTooltip(bar, relevance === undefined ? SIMILARITY_TIER_LABELS[tier] : `Relevance: ${Math.round(relevance * 100)}%`);
	return bar;
}

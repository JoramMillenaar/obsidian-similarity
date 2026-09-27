import { setTooltip } from "obsidian";
import { RelatedNote } from "../types";
import { SIMILARITY_TIER_LABELS } from "../core/vector/similarityTier";

export function renderSimilarityBar(parent: HTMLElement, note: RelatedNote): HTMLElement {
	const bar = parent.createDiv({cls: `similarity-bar similarity-tier-${note.tier}`});
	const fill = bar.createDiv({cls: "similarity-bar-fill"});
	fill.setCssProps({"--similarity-fill": `${Math.round(note.scaledScore * 100)}%`});
	setTooltip(bar, SIMILARITY_TIER_LABELS[note.tier]);
	return bar;
}

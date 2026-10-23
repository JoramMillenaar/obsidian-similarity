import { setIcon, setTooltip } from "obsidian";
import { RelatedNote } from "../types";
import { SIMILARITY_TIER_LABELS } from "../core/vector/similarityTier";
import { KEYWORD_MATCH, MATCH_KINDS } from "../constants";

/** Shows whether the search's words (keyword), a passage (precise) or the notes as a whole (average) matched. */
export function renderMatchIcon(parent: HTMLElement, note: RelatedNote, cls: string): HTMLElement {
	const kind = note.keyword ? KEYWORD_MATCH : MATCH_KINDS[note.match];
	const icon = parent.createDiv({cls: `similarity-match-icon ${cls}`});
	setIcon(icon, kind.icon);
	setTooltip(icon, `${kind.label}: ${kind.desc}`);
	return icon;
}

export function renderSimilarityBar(parent: HTMLElement, note: RelatedNote): HTMLElement {
	const bar = parent.createDiv({cls: `similarity-bar similarity-tier-${note.tier}`});
	const fill = bar.createDiv({cls: "similarity-bar-fill"});
	fill.setCssProps({"--similarity-fill": `${Math.round(note.scaledScore * 100)}%`});
	setTooltip(bar, SIMILARITY_TIER_LABELS[note.tier]);
	return bar;
}

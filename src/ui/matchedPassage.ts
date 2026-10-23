import { RelatedNote } from "../types";
import { GetMatchedPassageUseCase, PassageSource } from "../search/getMatchedPassage";

/** What the results were found for: where their query passages come from, and what to call it. */
export type MatchQuery = {
	source: PassageSource;
	label: string;
};

/**
 * What a result matched on, collapsed until the result is hovered (see styles.css). Precise: both
 * passages of the best pair. Average: the result's passage nearest the query's centroid. Passages
 * that can't be recovered (their note changed since it was indexed) are left out.
 */
export function renderMatchedPassage(
	parent: HTMLElement,
	note: RelatedNote,
	getMatchedPassage: GetMatchedPassageUseCase,
	query: MatchQuery,
): void {
	const passage = note.passage;
	if (!passage) return;

	const panel = parent.createDiv({cls: "similarity-passage"});
	const body = panel.createDiv({cls: "similarity-passage-body"});

	// Both sides are read ahead of the hover, so the panel opens with its text already in place.
	if (note.match === "precise" && note.queryPassage) {
		const queryQuote = createQuote(body, query.label);
		void getMatchedPassage(query.source, note.queryPassage)
			.then((text) => fill(queryQuote, text))
			.catch(() => queryQuote.remove());
	}

	const quote = createQuote(body, note.match === "precise" ? "Matched passage" : "Nearest the average");
	getMatchedPassage({noteId: note.id}, passage)
		.then((text) => {
			if (!fill(quote, text)) panel.remove();
		})
		.catch(() => panel.remove());
}

function createQuote(parent: HTMLElement, label: string): HTMLElement {
	const quote = parent.createDiv({cls: "similarity-passage-quote"});
	quote.createDiv({cls: "similarity-passage-label", text: label});
	return quote;
}

/** Fills a quote with its passage, or removes it when there's none; whether it was filled. */
function fill(quote: HTMLElement, text: string | null): boolean {
	const trimmed = text?.replace(/\s+/g, " ").trim();
	if (!trimmed) {
		quote.remove();
		return false;
	}
	quote.createDiv({cls: "similarity-passage-text", text: trimmed});
	return true;
}

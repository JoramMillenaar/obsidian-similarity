import { RelatedNote } from "../types";
import { GetMatchedPassageUseCase } from "../search/getMatchedPassage";

/**
 * The passage of a result that matched, collapsed until the result is hovered (see styles.css):
 * the result's side of the best pair for a precise match, its passage nearest the query's centroid
 * for an average one. Left out when it can't be recovered (the note changed since it was indexed).
 */
export function renderMatchedPassage(parent: HTMLElement, note: RelatedNote, getMatchedPassage: GetMatchedPassageUseCase): void {
	const passage = note.passage;
	if (!passage) return;

	const panel = parent.createDiv({cls: "similarity-passage"});
	const quote = panel.createDiv({cls: "similarity-passage-body"}).createDiv({cls: "similarity-passage-quote"});
	// Read ahead of the hover, so the panel opens with its text already in place.
	getMatchedPassage(note.id, passage)
		.then((text) => {
			const trimmed = text?.replace(/\s+/g, " ").trim();
			if (trimmed) quote.createDiv({cls: "similarity-passage-text", text: trimmed});
			else panel.remove();
		})
		.catch(() => panel.remove());
}

import { RelatedNote } from "../types";
import { GetMatchedPassageUseCase } from "../search/getMatchedPassage";

/** The passage a result matched on, filled in once its text is read; dropped if it can't be recovered. */
export function renderMatchedPassage(parent: HTMLElement, note: RelatedNote, getMatchedPassage: GetMatchedPassageUseCase, cls: string): void {
	const passage = note.passage;
	if (!passage) return;

	const el = parent.createDiv({cls: `similarity-passage ${cls}`});
	getMatchedPassage(note.id, passage)
		.then((text) => {
			const trimmed = text?.replace(/\s+/g, " ").trim();
			if (trimmed) el.setText(trimmed);
			else el.remove();
		})
		.catch(() => el.remove());
}

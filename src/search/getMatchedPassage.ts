import { PassageSpan } from "../types";
import { GetNoteTextUseCase } from "../app/getNoteText";
import { hashText } from "../core/text/hash";

/** Where a passage's span points into: a note's prepared text, or text searched for directly. */
export type PassageSource = { noteId: string } | { text: string };

/** The text of a matched passage, or null when its source changed since it was embedded. */
export type GetMatchedPassageUseCase = (source: PassageSource, passage: PassageSpan) => Promise<string | null>;

const MAX_CACHED_PASSAGES = 500;

export function makeGetMatchedPassage(deps: {
	getNoteText: GetNoteTextUseCase;
}): GetMatchedPassageUseCase {
	// Keyed by the passage's own hash, so a hit is always the exact text that was embedded.
	const cache = new Map<string, string>();

	return async function getMatchedPassage(source, {start, end, hash}) {
		const cached = cache.get(hash);
		if (cached !== undefined) return cached;

		const text = "text" in source ? source.text : (await deps.getNoteText(source.noteId)).text;
		const passage = text.slice(start, end);
		if (hashText(passage) !== hash) return null;

		if (cache.size >= MAX_CACHED_PASSAGES) cache.delete(cache.keys().next().value as string);
		cache.set(hash, passage);
		return passage;
	};
}

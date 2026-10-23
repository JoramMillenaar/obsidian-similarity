import { PassageSpan } from "../types";
import { GetNoteTextUseCase } from "../app/getNoteText";
import { hashText } from "../core/text/hash";

/** The text of a matched passage, or null when its note changed since it was indexed. */
export type GetMatchedPassageUseCase = (noteId: string, passage: PassageSpan) => Promise<string | null>;

const MAX_CACHED_PASSAGES = 500;

export function makeGetMatchedPassage(deps: {
	getNoteText: GetNoteTextUseCase;
}): GetMatchedPassageUseCase {
	// Keyed by the passage's own hash, so a hit is always the exact text that was embedded.
	const cache = new Map<string, string>();

	return async function getMatchedPassage(noteId, {start, end, hash}) {
		const cached = cache.get(hash);
		if (cached !== undefined) return cached;

		const {text} = await deps.getNoteText(noteId);
		const passage = text.slice(start, end);
		if (hashText(passage) !== hash) return null;

		if (cache.size >= MAX_CACHED_PASSAGES) cache.delete(cache.keys().next().value as string);
		cache.set(hash, passage);
		return passage;
	};
}

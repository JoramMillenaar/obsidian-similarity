import { RelatedNote } from "../types";
import { EmbeddingResult } from "../ports";
import { IndexHandle } from "../indexing/store/indexHandle";
import { KeywordHit } from "./keywordSearch";

export type GetSimilarNotesForTextUseCase = (args: {
	text: string;
	limit?: number;
	minScore?: number;
}) => Promise<RelatedNote[]>;

export function makeGetSimilarNotesForText(deps: {
	index: IndexHandle;
	embed: (text: string) => Promise<EmbeddingResult | null>;
	/** Notes containing the search's words, put above the meaning-based results. */
	findKeywordHits?: (text: string) => Promise<KeywordHit[]>;
}): GetSimilarNotesForTextUseCase {
	return async function getSimilarNotesForText({text, limit, minScore}): Promise<RelatedNote[]> {
		const keywordHits = deps.findKeywordHits?.(text).catch((error) => {
			console.error("[Similarity] Keyword search failed:", error);
			return [];
		});
		const embedded = await deps.embed(text);
		if (!embedded?.chunks.length) throw new Error("getSimilarNotesForText: could not embed text");

		const queryChunks = embedded.chunks.map((chunk) => chunk.embedding);
		return deps.index.query(queryChunks, {limit, minScore, pinned: await keywordHits});
	};
}

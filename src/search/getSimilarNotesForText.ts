import { RelatedNote } from "../types";
import { EmbeddingResult } from "../ports";
import { IndexHandle } from "../indexing/store/indexHandle";

export type GetSimilarNotesForTextUseCase = (args: {
	text: string;
	limit?: number;
	minScore?: number;
}) => Promise<RelatedNote[]>;

export function makeGetSimilarNotesForText(deps: {
	index: IndexHandle;
	embed: (text: string) => Promise<EmbeddingResult | null>;
}): GetSimilarNotesForTextUseCase {
	return async function getSimilarNotesForText({text, limit, minScore}): Promise<RelatedNote[]> {
		const embedded = await deps.embed(text);
		if (!embedded?.chunks.length) throw new Error("getSimilarNotesForText: could not embed text");

		const queryChunks = embedded.chunks.map((chunk) => chunk.embedding);
		return deps.index.query(queryChunks, {limit, minScore});
	};
}

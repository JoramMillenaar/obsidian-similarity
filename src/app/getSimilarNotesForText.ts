import { RelatedNote } from "../types";
import { IndexRepository } from "../ports";
import { rankSimilarNotes } from "../domain/embedding";
import { EmbedTextUseCase } from "./embedText";

export type GetSimilarNotesForTextUseCase = (args: {
	text: string;
	limit?: number;
	minScore?: number;
}) => Promise<RelatedNote[]>;

export function makeGetSimilarNotesForText(deps: {
	indexRepo: IndexRepository;
	embedText: EmbedTextUseCase;
}): GetSimilarNotesForTextUseCase {
	return async function getSimilarNotesForText({text, limit, minScore}): Promise<RelatedNote[]> {
		const embedded = await deps.embedText(text);
		if (!embedded?.chunks.length) throw new Error("getSimilarNotesForText: could not embed text");

		const queryChunks = embedded.chunks.map((chunk) => chunk.embedding);
		const indexedNotes = await deps.indexRepo.listAll();

		return rankSimilarNotes(queryChunks, indexedNotes, {limit, minScore});
	}
}

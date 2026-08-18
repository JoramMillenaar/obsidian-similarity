import { RelatedNote } from "../types";
import { IndexRepository } from "../ports";
import { rankSimilarNotes } from "../domain/embedding";

export type GetSimilarNotesForNoteUseCase = (args: {
	noteId: string;
	limit?: number;
	minScore?: number;
}) => Promise<RelatedNote[]>;

export function makeGetSimilarNotesForNote(deps: {
	indexRepo: IndexRepository;
}): GetSimilarNotesForNoteUseCase {
	return async function getSimilarNotesForNote({noteId, limit, minScore}): Promise<RelatedNote[]> {
		const existing = await deps.indexRepo.findById(noteId);
		if (!existing) return [];

		const queryChunks = existing.chunks.map((chunk) => chunk.embedding);
		const indexedNotes = await deps.indexRepo.listAll();

		return rankSimilarNotes(queryChunks, indexedNotes, {excludeId: noteId, limit, minScore});
	}
}

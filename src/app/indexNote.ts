import { hashText } from "../domain/text";
import { normalizeEmbedding, quantizeEmbedding } from "../domain/embedding";
import { isMarkdownPath } from "../domain/markdownPath";
import { EmbeddedChunk, IndexRepository } from "../ports";
import { NoteChunk } from "../types";
import { EmbedTextUseCase, Priority } from "./embedText";
import { IsIgnoredPath } from "./isIgnoredPath";
import { GetNoteTextUseCase } from "./getNoteText";

export type IndexNoteDeps = {
	getNoteText: GetNoteTextUseCase;
	indexRepo: IndexRepository;
	isIgnoredPath: IsIgnoredPath;
	embedText: EmbedTextUseCase;
};

export type IndexNoteOutcome = "indexed" | "removed" | "unchanged";

export type IndexNoteUseCase = (
	noteId: string,
	priority?: Priority,
) => Promise<IndexNoteOutcome>;

export function makeIndexNote(deps: IndexNoteDeps): IndexNoteUseCase {
	return async function indexNote(noteId: string, priority?: Priority) {
		if (!isMarkdownPath(noteId)) {
			await deps.indexRepo.remove(noteId);
			return "removed";
		}

		if (await deps.isIgnoredPath(noteId)) {
			await deps.indexRepo.remove(noteId);
			return "removed";
		}

		let text: string;
		try {
			text = await deps.getNoteText(noteId);
		} catch {
			await deps.indexRepo.remove(noteId);
			return "removed";
		}

		const contentHash = hashText(text);

		const existing = await deps.indexRepo.findById(noteId);
		if (existing && existing.contentHash === contentHash) {
			return "unchanged";
		}

		let embedded: EmbeddedChunk[] | null;
		try {
			embedded = await deps.embedText(text, priority);
		} catch (error) {
			await deps.indexRepo.remove(noteId);
			throw error;
		}
		if (!embedded?.length) {
			await deps.indexRepo.remove(noteId);
			return "removed";
		}

		const indexedNote = {
			id: noteId,
			chunks: toNoteChunks(embedded, text),
			contentHash,
			updatedAt: new Date().toISOString(),
		};

		await deps.indexRepo.upsert(indexedNote);
		return "indexed";
	}
}

function toNoteChunks(embedded: EmbeddedChunk[], preparedText: string): NoteChunk[] {
	return embedded.map((chunk) => ({
		embedding: quantizeEmbedding(normalizeEmbedding(chunk.embedding)),
		start: chunk.start,
		end: chunk.end,
		hash: hashText(preparedText.slice(chunk.start, chunk.end)),
	}));
}

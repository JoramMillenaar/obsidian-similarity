import { hashText } from "../domain/text";
import { isMarkdownPath } from "../domain/markdownPath";
import { EmbeddedChunk, EmbeddingResult, IndexRepository } from "../ports";
import { NoteChunk } from "../types";
import { EmbedTextUseCase } from "./embedText";
import { IsIgnoredPath } from "./isIgnoredPath";
import { GetNoteTextUseCase } from "./getNoteText";

export type IndexNoteDeps = {
	getNoteText: GetNoteTextUseCase;
	indexRepo: IndexRepository;
	isIgnoredPath: IsIgnoredPath;
	embedText: EmbedTextUseCase;
};

export type IndexNoteOutcome = "indexed" | "removed" | "unchanged";

export type IndexNoteUseCase = (noteId: string) => Promise<IndexNoteOutcome>;

export function makeIndexNote(deps: IndexNoteDeps): IndexNoteUseCase {
	return async function indexNote(noteId: string) {
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

		const embedded: EmbeddingResult | null = await deps.embedText(text);
		if (!embedded?.chunks.length) {
			await deps.indexRepo.remove(noteId);
			return "removed";
		}

		const indexedNote = {
			id: noteId,
			chunks: toNoteChunks(embedded.chunks, text),
			contentHash,
			updatedAt: new Date().toISOString(),
		};

		await deps.indexRepo.upsert(indexedNote, embedded.metadata.embeddingModelId);
		return "indexed";
	}
}

function toNoteChunks(embedded: EmbeddedChunk[], preparedText: string): NoteChunk[] {
	return embedded.map((chunk) => ({
		embedding: chunk.embedding,
		start: chunk.start,
		end: chunk.end,
		hash: hashText(preparedText.slice(chunk.start, chunk.end)),
	}));
}

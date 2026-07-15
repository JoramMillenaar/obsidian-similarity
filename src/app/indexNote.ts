import { hashText } from "../domain/text";
import { normalizeEmbedding } from "../domain/embedding";
import { isMarkdownPath } from "../domain/markdownPath";
import { EmbeddedChunk } from "../ports";
import { NoteChunk, PrepareNoteResult } from "../types";
import { IndexRepository } from "../ports";
import { EmbedTextUseCase } from "./embedText";
import { IsIgnoredPath } from "./isIgnoredPath";
import { PrepareNoteForEmbeddingUseCase } from "./prepareNoteForEmbedding";

export type IndexNoteDeps = {
	prepareNoteForEmbedding: PrepareNoteForEmbeddingUseCase;
	embedText: EmbedTextUseCase;
	indexRepo: IndexRepository;
	isIgnoredPath: IsIgnoredPath;
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

		let prepared: PrepareNoteResult;
		try {
			prepared = await deps.prepareNoteForEmbedding(noteId);
		} catch (error) {
			await deps.indexRepo.remove(noteId);
			throw error;
		}
		if (prepared.status === "reject") {
			await deps.indexRepo.remove(noteId);
			return "removed";
		}

		const contentHash = hashText(prepared.value.preparedText);

		const existing = await deps.indexRepo.findById(noteId);
		if (existing && existing.contentHash === contentHash) {
			return "unchanged";
		}

		let embedded: EmbeddedChunk[] | null;
		try {
			embedded = await deps.embedText(prepared.value.preparedText);
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
			chunks: toNoteChunks(embedded, prepared.value.preparedText),
			contentHash,
			updatedAt: new Date().toISOString(),
		};

		await deps.indexRepo.upsert(indexedNote);
		return "indexed";
	}
}

function toNoteChunks(embedded: EmbeddedChunk[], preparedText: string): NoteChunk[] {
	return embedded.map((chunk) => ({
		// The model already returns unit vectors, but the binary sidecar's int8
		// quantization assumes it — re-normalize so that stays true by construction.
		embedding: normalizeEmbedding(chunk.embedding),
		start: chunk.start,
		end: chunk.end,
		hash: hashText(preparedText.slice(chunk.start, chunk.end)),
	}));
}

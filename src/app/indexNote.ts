import { hashText } from "../core/text/hash";
import { isMarkdownPath } from "../core/rules/markdownPath";
import { EmbeddedChunk, EmbeddingResult } from "../ports";
import { NoteChunk } from "../types";
import { IsIgnoredPath } from "./isIgnoredPath";
import { GetNoteTextUseCase } from "./getNoteText";
import { IndexHandle } from "../indexing/store/indexHandle";

export type IndexNoteDeps = {
	getNoteText: GetNoteTextUseCase;
	index: IndexHandle;
	isIgnoredPath: IsIgnoredPath;
	embedText: (text: string) => Promise<EmbeddingResult | null>;
};

export type IndexNoteOutcome = "indexed" | "removed" | "unchanged";

export type IndexNoteUseCase = (noteId: string) => Promise<IndexNoteOutcome>;

export function makeIndexNote(deps: IndexNoteDeps): IndexNoteUseCase {
	return async function indexNote(noteId: string) {
		if (!isMarkdownPath(noteId)) {
			deps.index.remove(noteId);
			return "removed";
		}

		if (deps.isIgnoredPath(noteId)) {
			deps.index.remove(noteId);
			return "removed";
		}

		let text: string;
		try {
			text = await deps.getNoteText(noteId);
		} catch {
			deps.index.remove(noteId);
			return "removed";
		}

		const contentHash = hashText(text);

		const existing = deps.index.get(noteId);
		if (existing && existing.contentHash === contentHash) {
			return "unchanged";
		}

		const embedded: EmbeddingResult | null = await deps.embedText(text);
		if (!embedded?.chunks.length) {
			deps.index.remove(noteId);
			return "removed";
		}

		if (embedded.metadata.embeddingModelId !== deps.index.modelId) {
			console.warn(
				`[Similarity] Dropped embedding for "${noteId}": computed with ${embedded.metadata.embeddingModelId}, index expects ${deps.index.modelId}.`,
			);
			return "unchanged";
		}

		deps.index.upsert({
			id: noteId,
			chunks: toNoteChunks(embedded.chunks, text),
			contentHash,
			updatedAt: new Date().toISOString(),
		});
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

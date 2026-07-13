import { hashText } from "../domain/text";
import { averageEmbeddings, normalizeEmbedding } from "../domain/embedding";
import { isMarkdownPath } from "../domain/markdownPath";
import { PrepareNoteResult } from "../types";
import { IndexRepository, SettingsRepository } from "../ports";
import { EmbedTextChunksUseCase } from "./embedText";
import { IsIgnoredPath } from "./isIgnoredPath";
import { PrepareNoteForEmbeddingUseCase } from "./prepareNoteForEmbedding";

export type IndexNoteDeps = {
	prepareNoteForEmbedding: PrepareNoteForEmbeddingUseCase;
	embedTextChunks: EmbedTextChunksUseCase;
	indexRepo: IndexRepository;
	settingsRepo: SettingsRepository;
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

		let chunkVectors: number[][] | null;
		try {
			chunkVectors = await deps.embedTextChunks(prepared.value.preparedText);
		} catch (error) {
			await deps.indexRepo.remove(noteId);
			throw error;
		}
		if (!chunkVectors?.length) {
			await deps.indexRepo.remove(noteId);
			return "removed";
		}

		const settings = await deps.settingsRepo.get();
		const normalizedChunks = chunkVectors.map(normalizeEmbedding);
		const embeddings = settings.storeAllChunks
			? normalizedChunks
			: [normalizeEmbedding(averageEmbeddings(normalizedChunks)!)];

		const indexedNote = {
			id: noteId,
			embeddings,
			contentHash,
			updatedAt: new Date().toISOString(),
		};

		await deps.indexRepo.upsert(indexedNote);
		return "indexed";
	}
}

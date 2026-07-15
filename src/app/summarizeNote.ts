import { findCentroidText } from "../domain/centroid";
import { averageEmbeddings, normalizeEmbedding } from "../domain/embedding";
import { hashText } from "../domain/text";
import { IndexRepository, SettingsRepository } from "../ports";
import { EmbedTextUseCase } from "./embedText";
import { PrepareNoteForEmbeddingUseCase } from "./prepareNoteForEmbedding";

export type SummarizeNoteOutcome = "summarized" | "skipped";
export type SummarizeNoteUseCase = (noteId: string) => Promise<SummarizeNoteOutcome>;

/**
 * Computes and caches a note's centroid description. Runs after indexing,
 * because it needs the note's finished chunk embeddings to know what its
 * average meaning even is.
 */
export function makeSummarizeNote(deps: {
	indexRepo: IndexRepository;
	prepareNoteForEmbedding: PrepareNoteForEmbeddingUseCase;
	embedText: EmbedTextUseCase;
	settingsRepo: SettingsRepository;
}): SummarizeNoteUseCase {
	return async function summarizeNote(noteId: string): Promise<SummarizeNoteOutcome> {
		const existing = await deps.indexRepo.findById(noteId);
		if (!existing || existing.centroid !== undefined || existing.chunks.length === 0) {
			return "skipped";
		}

		// Chunks are stored as spans into the prepared text, which isn't persisted
		// (it would dwarf the rest of data.json), so rebuild it to read them back.
		const prepared = await deps.prepareNoteForEmbedding(noteId);
		if (prepared.status === "reject") return "skipped";

		// The note may have changed since it was indexed, which would leave every
		// stored span pointing at the wrong text. Re-indexing will queue it again.
		if (hashText(prepared.value.preparedText) !== existing.contentHash) return "skipped";

		const settings = await deps.settingsRepo.get();
		const centroid = await findCentroidText({
			preparedText: prepared.value.preparedText,
			chunks: existing.chunks,
			steps: settings.centroidSearchSteps,
			embedOne: (text) => embedOne(text, deps.embedText),
		});
		if (!centroid) return "skipped";

		await deps.indexRepo.upsert({...existing, centroid});
		return "summarized";
	};
}

/**
 * Embeds a single passage into one vector. The search only ever embeds halves
 * of an existing chunk, which always fit the model's budget and so come back as
 * one chunk; pooling defensively keeps that an optimization rather than an
 * assumption the caller has to hold.
 */
async function embedOne(text: string, embedText: EmbedTextUseCase): Promise<number[] | null> {
	const chunks = await embedText(text);
	if (!chunks?.length) return null;

	const pooled = averageEmbeddings(chunks.map((chunk) => chunk.embedding));
	return pooled ? normalizeEmbedding(pooled) : null;
}

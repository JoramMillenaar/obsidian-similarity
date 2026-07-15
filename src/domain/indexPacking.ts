import { ChunkEntryV2, IndexedNote, IndexEntryV2, IndexV2, NoteChunk } from "../types";

export type PackedIndex = {
	index: IndexV2;
	embeddings: Float32Array;
	dim: number;
};

/**
 * Pure transform: notes with inline chunk embeddings -> slim v2 index entries +
 * one packed Float32Array. Every chunk of every note gets its own row; an entry
 * points at its rows and records the span of prepared text each one covers.
 *
 * Notes are sorted by id before row assignment so this is deterministic:
 * running it twice on the same input produces byte-identical output, which is
 * what makes a rewrite idempotent and safe to re-run after a crash.
 */
export function packIndexedNotesToV2(notes: IndexedNote[]): PackedIndex {
	const dim = notes.find((note) => note.chunks.length > 0)?.chunks[0].embedding.length ?? 0;
	const sorted = [...notes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

	const totalChunks = sorted.reduce((count, note) => count + note.chunks.length, 0);
	const embeddings = new Float32Array(totalChunks * dim);

	let row = 0;
	const index: IndexV2 = sorted.map((note) => {
		const chunks: ChunkEntryV2[] = note.chunks.map((chunk) => {
			if (chunk.embedding.length !== dim) {
				throw new Error(
					`packIndexedNotesToV2: embedding for "${note.id}" has length ${chunk.embedding.length}, expected ${dim}`,
				);
			}
			embeddings.set(chunk.embedding, row * dim);

			const entry: ChunkEntryV2 = {row, start: chunk.start, end: chunk.end, hash: chunk.hash};
			row++;
			return entry;
		});

		const entry: IndexEntryV2 = {
			id: note.id,
			contentHash: note.contentHash,
			updatedAt: note.updatedAt,
			chunks,
		};
		return entry;
	});

	return {index, embeddings, dim};
}

/** Inverse of packIndexedNotesToV2: zips v2 entries with their row vectors back into IndexedNote[]. */
export function unpackV2ToIndexedNotes(
	index: IndexV2,
	embeddings: Float32Array,
	dim: number,
	count: number,
): IndexedNote[] {
	const notes: IndexedNote[] = [];

	for (const entry of index) {
		const chunks: NoteChunk[] = [];

		for (const chunk of entry.chunks) {
			if (chunk.row < 0 || chunk.row >= count) continue;

			chunks.push({
				embedding: Array.from(embeddings.subarray(chunk.row * dim, (chunk.row + 1) * dim)),
				start: chunk.start,
				end: chunk.end,
				hash: chunk.hash,
			});
		}

		if (chunks.length === 0) continue;

		notes.push({
			id: entry.id,
			chunks,
			contentHash: entry.contentHash,
			updatedAt: entry.updatedAt,
		});
	}

	return notes;
}

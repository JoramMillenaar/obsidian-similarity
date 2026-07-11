import { ChunkEntryV2, IndexedNote, IndexEntryV2, IndexV2 } from "../types";

export type PackedIndex = {
	index: IndexV2;
	embeddings: Float32Array;
	dim: number;
};

/**
 * Pure transform: notes with inline embeddings -> slim v2 index entries + one
 * packed Float32Array. Never touches an embedding provider — the float64->
 * float32 conversion happens implicitly when values are assigned into the
 * typed array, so this can never recompute an embedding, only repack existing
 * ones.
 *
 * Notes are sorted by id before row assignment so this is deterministic:
 * running it twice on the same input produces byte-identical output, which is
 * what makes migration/rewrite idempotent and safe to re-run after a crash.
 */
export function packIndexedNotesToV2(notes: IndexedNote[]): PackedIndex {
	const dim = notes[0]?.embedding.length ?? 0;
	const sorted = [...notes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

	const embeddings = new Float32Array(sorted.length * dim);
	const index: IndexV2 = sorted.map((note, row) => {
		if (note.embedding.length !== dim) {
			throw new Error(
				`packIndexedNotesToV2: embedding for "${note.id}" has length ${note.embedding.length}, expected ${dim}`,
			);
		}
		embeddings.set(note.embedding, row * dim);

		const chunk: ChunkEntryV2 = {row, start: 0, end: 0, hash: note.contentHash};
		const entry: IndexEntryV2 = {
			id: note.id,
			contentHash: note.contentHash,
			updatedAt: note.updatedAt,
			chunks: [chunk],
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
		const row = entry.chunks[0]?.row;
		if (row === undefined || row < 0 || row >= count) continue;

		const vector = embeddings.subarray(row * dim, (row + 1) * dim);
		notes.push({
			id: entry.id,
			embedding: Array.from(vector),
			contentHash: entry.contentHash,
			updatedAt: entry.updatedAt,
		});
	}
	return notes;
}

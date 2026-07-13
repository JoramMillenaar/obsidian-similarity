import { ChunkEntryV2, IndexedNote, IndexEntryV2, IndexV2 } from "../types";

export type PackedIndex = {
	index: IndexV2;
	embeddings: Float32Array;
	dim: number;
};

/**
 * Pure transform: notes with inline chunk embeddings -> slim v2 index entries +
 * one packed Float32Array with a row per chunk vector. Never touches an
 * embedding provider — the float64->float32 conversion happens implicitly when
 * values are assigned into the typed array, so this can never recompute an
 * embedding, only repack existing ones.
 *
 * Notes are sorted by id before row assignment so this is deterministic:
 * running it twice on the same input produces byte-identical output, which is
 * what makes migration/rewrite idempotent and safe to re-run after a crash.
 * Within a note, chunk vectors keep their original order.
 */
export function packIndexedNotesToV2(notes: IndexedNote[]): PackedIndex {
	const dim = notes.find(n => n.embeddings.length > 0)?.embeddings[0]?.length ?? 0;
	const sorted = [...notes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

	const totalRows = sorted.reduce((sum, note) => sum + note.embeddings.length, 0);
	const embeddings = new Float32Array(totalRows * dim);

	let row = 0;
	const index: IndexV2 = sorted.map((note) => {
		const chunks: ChunkEntryV2[] = note.embeddings.map((vector) => {
			if (vector.length !== dim) {
				throw new Error(
					`packIndexedNotesToV2: embedding for "${note.id}" has length ${vector.length}, expected ${dim}`,
				);
			}
			embeddings.set(vector, row * dim);
			const chunk: ChunkEntryV2 = {row};
			row += 1;
			return chunk;
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

/** Inverse of packIndexedNotesToV2: zips v2 entries with their chunk row vectors back into IndexedNote[]. */
export function unpackV2ToIndexedNotes(
	index: IndexV2,
	embeddings: Float32Array,
	dim: number,
	count: number,
): IndexedNote[] {
	const notes: IndexedNote[] = [];
	for (const entry of index) {
		const vectors: number[][] = [];
		for (const chunk of entry.chunks) {
			const row = chunk?.row;
			if (row === undefined || row < 0 || row >= count) continue;
			vectors.push(Array.from(embeddings.subarray(row * dim, (row + 1) * dim)));
		}
		if (vectors.length === 0) continue;

		notes.push({
			id: entry.id,
			embeddings: vectors,
			contentHash: entry.contentHash,
			updatedAt: entry.updatedAt,
		});
	}
	return notes;
}

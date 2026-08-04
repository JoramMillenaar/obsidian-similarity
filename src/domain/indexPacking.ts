import { ChunkEntryV2, IndexedNote, IndexEntryV2, IndexV2, NoteChunk } from "../types";

export type PackedIndex = {
	index: IndexV2;
	embeddings: Float32Array;
	dim: number;
	chunkCount: number;
};

export function packForStorage(notes: IndexedNote[]): PackedIndex {
	const dim = notes.find((note) => note.chunks.length > 0)?.chunks[0].embedding.length ?? 0;
	const sorted = [...notes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

	const chunkCount = sorted.reduce((count, note) => count + note.chunks.length, 0);
	const embeddings = new Float32Array(chunkCount * dim);

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

	return {index, embeddings, dim, chunkCount};
}

export function unpackFromStorage(packedIndex: PackedIndex): IndexedNote[] {
	const notes: IndexedNote[] = [];

	for (const entry of packedIndex.index) {
		const chunks: NoteChunk[] = [];

		for (const chunk of entry.chunks) {
			if (chunk.row < 0 || chunk.row >= packedIndex.chunkCount) continue;

			chunks.push({
				embedding: Array.from(packedIndex.embeddings.subarray(chunk.row * packedIndex.dim, (chunk.row + 1) * packedIndex.dim)),
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

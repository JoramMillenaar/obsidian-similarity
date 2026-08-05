import { ChunkMetadata, IndexedNote, NoteIndexMetadata, IndexMetadata, NoteChunk } from "../types";

export type PackedIndex = {
	metadata: IndexMetadata;
	embeddings: Int8Array;
	dim: number;
	chunkCount: number;
};

export function packForStorage(notes: IndexedNote[], dim: number): PackedIndex {
	const sorted = [...notes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

	const chunkCount = sorted.reduce((count, note) => count + note.chunks.length, 0);
	const embeddings = new Int8Array(chunkCount * dim);

	let row = 0;
	const metadata: IndexMetadata = sorted.map((note) => {
		const chunks: ChunkMetadata[] = note.chunks.map((chunk) => {
			if (chunk.embedding.length !== dim) {
				throw new Error(
					`packForStorage: embedding for "${note.id}" has length ${chunk.embedding.length}, expected ${dim}`,
				);
			}
			embeddings.set(chunk.embedding, row * dim);

			const entry: ChunkMetadata = {row, start: chunk.start, end: chunk.end, hash: chunk.hash};
			row++;
			return entry;
		});

		const entry: NoteIndexMetadata = {
			id: note.id,
			contentHash: note.contentHash,
			updatedAt: note.updatedAt,
			chunks,
		};
		return entry;
	});

	return {metadata, embeddings, dim, chunkCount};
}

export function unpackFromStorage(packedIndex: PackedIndex): IndexedNote[] {
	const notes: IndexedNote[] = [];

	for (const entry of packedIndex.metadata) {
		const chunks: NoteChunk[] = [];

		for (const chunk of entry.chunks) {
			if (chunk.row < 0 || chunk.row >= packedIndex.chunkCount) continue;

			chunks.push({
				embedding: packedIndex.embeddings.subarray(chunk.row * packedIndex.dim, (chunk.row + 1) * packedIndex.dim),
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

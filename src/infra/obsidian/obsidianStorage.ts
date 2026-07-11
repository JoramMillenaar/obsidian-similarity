import { IndexedNote, IndexEntryV2, SCHEMA_VERSION } from "../../types";
import { IndexStorage } from "../../ports";
import { ObsidianPluginDataStore } from "./obsidianPluginDataStore";
import { BinaryEmbeddingFileStore } from "./binaryEmbeddingFileStore";
import { decodeEmbeddings, encodeEmbeddings, isBinaryLayoutValid } from "../../domain/embeddingCodec";
import { packIndexedNotesToV2, unpackV2ToIndexedNotes } from "../../domain/migrateEmbeddingStore";

/**
 * Backs IndexStorage with a slim JSON index (schemaVersion 2: id/contentHash/
 * updatedAt/chunks, no floats) plus the embeddings binary sidecar. Callers
 * still deal only in IndexedNote[] with inline `embedding: number[]` — the
 * binary split is entirely an implementation detail behind this adapter.
 */
export class ObsidianPluginDataIndexStorage implements IndexStorage {
	constructor(
		private readonly store: ObsidianPluginDataStore,
		private readonly binaryStore: BinaryEmbeddingFileStore,
	) {
	}

	async getAll(): Promise<IndexedNote[]> {
		const data = await this.store.read();
		if (data.schemaVersion < SCHEMA_VERSION) return [];

		const entries = data.index as IndexEntryV2[];
		if (entries.length === 0) return [];

		const buffer = await this.binaryStore.read();
		if (!buffer) return [];

		let decoded;
		try {
			decoded = decodeEmbeddings(buffer);
		} catch {
			return [];
		}
		if (decoded.dim !== data.embeddingDim) return [];

		return unpackV2ToIndexedNotes(entries, decoded.embeddings, decoded.dim, decoded.count);
	}

	async rewrite(index: IndexedNote[]): Promise<void> {
		const {index: v2, embeddings, dim} = packIndexedNotesToV2(index);
		const buffer = encodeEmbeddings(embeddings, dim);

		// Binary first, then JSON. Dying in between leaves schemaVersion stale, so a
		// re-run deterministically reproduces the identical binary — no temp files needed.
		await this.binaryStore.write(buffer);
		await this.store.update((current) => ({
			...current,
			schemaVersion: SCHEMA_VERSION,
			embeddingDim: dim,
			index: v2,
		}));
	}

	async flush(): Promise<void> {
		// rewrite() already writes synchronously — nothing to flush.
	}

	async isEmpty(): Promise<boolean> {
		const data = await this.store.read();
		if (data.index.length === 0) return true;

		// Pre-migration entries carry inline embeddings, so they're usable as-is.
		if (data.schemaVersion < SCHEMA_VERSION) return false;

		// v2 entries are only usable if the binary sidecar can actually supply
		// their vectors. If it's missing/corrupt/dim-mismatched, getAll() yields
		// [], so report empty here too — otherwise the UI thinks the index is
		// populated while every lookup silently returns nothing.
		const buffer = await this.binaryStore.read();
		if (!buffer) return true;

		try {
			const decoded = decodeEmbeddings(buffer);
			return decoded.dim !== data.embeddingDim;
		} catch {
			return true;
		}
	}

	async needsRebuild(): Promise<boolean> {
		const data = await this.store.read();
		if (data.schemaVersion < SCHEMA_VERSION) return false; // migration's job, not a rebuild
		if (data.index.length === 0) return false;

		const buffer = await this.binaryStore.read();
		if (!buffer) return true;

		try {
			const decoded = decodeEmbeddings(buffer);
			return (
				decoded.dim !== data.embeddingDim
				|| !isBinaryLayoutValid(buffer.byteLength, decoded.dim, decoded.count)
				|| decoded.count < data.index.length
			);
		} catch {
			return true;
		}
	}

	async readLegacy(): Promise<IndexedNote[] | null> {
		const data = await this.store.read();
		if (data.schemaVersion >= SCHEMA_VERSION) return null;
		return data.index as IndexedNote[];
	}
}

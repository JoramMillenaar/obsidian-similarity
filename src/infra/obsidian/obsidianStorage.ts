import { IndexedNote, IndexEntryV2, SCHEMA_VERSION } from "../../types";
import { EmbeddingFileStore, IndexRepairOutcome, IndexStorage, PluginDataStore } from "../../ports";
import { decodeEmbeddings, DecodedEmbeddings, encodeEmbeddings } from "../../domain/embeddingCodec";
import { packIndexedNotesToV2, unpackV2ToIndexedNotes } from "../../domain/indexPacking";
import { checkIndexHealth, SidecarState } from "../../domain/indexHealth";

/** The sidecar as read from disk: the raw bytes plus whatever we could decode from them. */
type SidecarRead = {
	state: SidecarState;
	decoded: DecodedEmbeddings | null;
};

/**
 * Backs IndexStorage with a slim JSON index (schemaVersion 2: id/contentHash/
 * updatedAt/chunks, no floats) plus the embeddings binary sidecar. Callers
 * still deal only in IndexedNote[] with inline chunk embeddings — the binary
 * split is entirely an implementation detail behind this adapter.
 */
export class ObsidianPluginDataIndexStorage implements IndexStorage {
	constructor(
		private readonly store: PluginDataStore,
		private readonly binaryStore: EmbeddingFileStore,
	) {
	}

	async getAll(): Promise<IndexedNote[]> {
		const data = await this.store.read();
		if (data.schemaVersion < SCHEMA_VERSION) return [];

		const entries = data.index as IndexEntryV2[];
		if (entries.length === 0) return [];

		const {decoded} = await this.readSidecar();
		if (!decoded || decoded.dim !== data.embeddingDim) return [];

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
		// getAll() already yields nothing for any index it cannot correctly serve,
		// so "empty" and "unusable" collapse to the same answer by construction.
		return (await this.getAll()).length === 0;
	}

	async repair(): Promise<IndexRepairOutcome> {
		const data = await this.store.read();
		const {state, decoded} = await this.readSidecar();

		const health = checkIndexHealth({
			schemaVersion: data.schemaVersion,
			embeddingDim: data.embeddingDim,
			entries: data.index,
			sidecar: state,
		});

		if (health.status === "unusable") {
			await this.rewrite([]);
			return {rebuildRequired: true, droppedIds: [], discardedReason: health.reason};
		}

		if (health.droppedIds.length === 0) {
			return {rebuildRequired: false, droppedIds: []};
		}

		// Repack the survivors: rewrite() reassigns rows from scratch, so the
		// dropped entries' vectors are compacted out of the sidecar as well.
		// `decoded` is non-null here — a checked (non-unusable) index with entries
		// can only come from a readable sidecar.
		const survivors = decoded
			? unpackV2ToIndexedNotes(health.validEntries, decoded.embeddings, decoded.dim, decoded.count)
			: [];
		await this.rewrite(survivors);

		return {rebuildRequired: survivors.length === 0, droppedIds: health.droppedIds};
	}

	/** Single read of the sidecar, classified for the health check. */
	private async readSidecar(): Promise<SidecarRead> {
		const buffer = await this.binaryStore.read();
		if (!buffer) return {state: {status: "missing"}, decoded: null};

		try {
			const decoded = decodeEmbeddings(buffer);
			return {
				state: {
					status: "ok",
					dim: decoded.dim,
					count: decoded.count,
					byteLength: buffer.byteLength,
				},
				decoded,
			};
		} catch {
			return {state: {status: "corrupt"}, decoded: null};
		}
	}
}

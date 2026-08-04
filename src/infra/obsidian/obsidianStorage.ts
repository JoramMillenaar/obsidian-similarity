import { IndexedNote, IndexEntryV2, SCHEMA_VERSION } from "../../types";
import { EmbeddingFileStore, IndexStorage, PluginDataStore } from "../../ports";
import { DecodedEmbeddings, decodeEmbeddings, encodeEmbeddings } from "../../domain/embeddingCodec";
import { packForStorage, unpackFromStorage } from "../../domain/indexPacking";
import { checkIndexHealth, SidecarState } from "../../domain/indexHealth";

type SidecarRead = {
	state: SidecarState;
	decoded: DecodedEmbeddings | null;
};

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

		return unpackFromStorage({
			index: entries,
			embeddings: decoded.embeddings,
			dim: decoded.dim,
			chunkCount: decoded.count
		});
	}

	async rewrite(index: IndexedNote[]): Promise<void> {
		const {index: v2, embeddings, dim} = packForStorage(index);
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
		return (await this.getAll()).length === 0;
	}

	async repair(): Promise<void> {
		const data = await this.store.read();
		const {state, decoded} = await this.readSidecar();

		const health = checkIndexHealth({
			schemaVersion: data.schemaVersion,
			embeddingDim: data.embeddingDim,
			entries: data.index,
			sidecar: state,
		});

		if (health.status === "unusable") {
			console.warn(`[Similarity] Index discarded (${health.reason}) — rebuilding from scratch.`);
			await this.rewrite([]);
			return;
		}

		if (health.droppedIds.length === 0) return;

		console.warn(
			`[Similarity] Dropped ${health.droppedIds.length} damaged index entries; they will be re-indexed.`,
		);

		const survivors = decoded
			? unpackFromStorage({
				index: health.validEntries,
				embeddings: decoded.embeddings,
				dim: decoded.dim,
				chunkCount: decoded.count
			})
			: [];
		await this.rewrite(survivors);
	}

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

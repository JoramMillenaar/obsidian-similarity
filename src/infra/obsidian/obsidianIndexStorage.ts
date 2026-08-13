import { EmbeddingModelId, IndexedNote, SCHEMA_VERSION } from "../../types";
import { EmbeddingFileStore, IndexStorage, ModelIndexMetaStore } from "../../ports";
import { DecodedEmbeddings, decodeEmbeddings, encodeEmbeddings } from "../../domain/embeddingCodec";
import { packForStorage, unpackFromStorage } from "../../domain/indexPacking";
import { checkIndexHealth, SidecarState } from "../../domain/indexHealth";
import { EMBEDDING_MODELS } from "../../constants";

type SidecarRead = {
	state: SidecarState;
	decoded: DecodedEmbeddings | null;
};

export class ObsidianIndexStorage implements IndexStorage {
	constructor(
		private readonly metaStore: ModelIndexMetaStore,
		private readonly binaryStore: EmbeddingFileStore,
	) {
	}

	async getAll(embeddingModelId: EmbeddingModelId): Promise<IndexedNote[]> {
		const data = await this.metaStore.read(embeddingModelId);
		if (!data || data.index.length === 0) return [];

		const {decoded} = await this.readSidecar(embeddingModelId);
		if (!decoded || decoded.dim !== data.embeddingDim) return [];

		return unpackFromStorage({
			metadata: data.index,
			embeddings: decoded.embeddings,
			dim: decoded.dim,
			chunkCount: decoded.count
		});
	}

	async rewrite(embeddingModelId: EmbeddingModelId, index: IndexedNote[]): Promise<void> {
		const {metadata: v2, embeddings, dim} = packForStorage(index, EMBEDDING_MODELS[embeddingModelId].dim);
		const buffer = encodeEmbeddings(embeddings, dim);

		// Binary first, then JSON. Dying in between leaves schemaVersion stale, so a
		// re-run deterministically reproduces the identical binary — no temp files needed.
		await this.binaryStore.write(embeddingModelId, buffer);
		await this.metaStore.write(embeddingModelId, {
			schemaVersion: SCHEMA_VERSION,
			embeddingDim: dim,
			index: v2,
		});
	}

	async isEmpty(embeddingModelId: EmbeddingModelId): Promise<boolean> {
		return (await this.getAll(embeddingModelId)).length === 0;
	}

	async repair(embeddingModelId: EmbeddingModelId): Promise<void> {
		const data = await this.metaStore.read(embeddingModelId);
		const {state, decoded} = await this.readSidecar(embeddingModelId);

		const health = checkIndexHealth({
			schemaVersion: data?.schemaVersion ?? 1,
			embeddingDim: data?.embeddingDim ?? 0,
			entries: data?.index ?? [],
			sidecar: state,
		});

		if (health.status === "unusable") {
			console.warn(`[Similarity] Index discarded (${health.reason}) — rebuilding from scratch.`);
			await this.rewrite(embeddingModelId, []);
			return;
		}

		if (health.droppedIds.length === 0) return;

		console.warn(
			`[Similarity] Dropped ${health.droppedIds.length} damaged index entries; they will be re-indexed.`,
		);

		const survivors = decoded
			? unpackFromStorage({
				metadata: health.validEntries,
				embeddings: decoded.embeddings,
				dim: decoded.dim,
				chunkCount: decoded.count
			})
			: [];
		await this.rewrite(embeddingModelId, survivors);
	}

	private async readSidecar(modelId: EmbeddingModelId): Promise<SidecarRead> {
		const buffer = await this.binaryStore.read(modelId);
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

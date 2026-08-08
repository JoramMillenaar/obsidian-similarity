import { EmbeddingModelId, IndexedNote } from "../types";

export interface IndexStorage {
	getAll(embeddingModelId: EmbeddingModelId): Promise<IndexedNote[]>;

	rewrite(embeddingModelId: EmbeddingModelId, index: IndexedNote[]): Promise<void>;

	isEmpty(embeddingModelId: EmbeddingModelId): Promise<boolean>;

	repair(embeddingModelId: EmbeddingModelId): Promise<void>;
}

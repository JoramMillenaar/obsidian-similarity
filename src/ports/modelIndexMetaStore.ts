import { EmbeddingModelId, ModelIndexFile } from "../types";

export interface ModelIndexMetaStore {
	read(modelId: EmbeddingModelId): Promise<ModelIndexFile | null>;

	write(modelId: EmbeddingModelId, data: ModelIndexFile): Promise<void>;
}

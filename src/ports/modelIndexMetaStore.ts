import { DeprecatedModelId, EmbeddingModelId, ModelIndexFile } from "../types";

export interface ModelIndexMetaStore {
	read(modelId: EmbeddingModelId): Promise<ModelIndexFile | null>;

	write(modelId: EmbeddingModelId, data: ModelIndexFile): Promise<void>;

	remove(modelId: DeprecatedModelId): Promise<boolean>;
}

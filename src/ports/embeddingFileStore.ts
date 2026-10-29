import { DeprecatedModelId, EmbeddingModelId } from "../types";

export interface EmbeddingFileStore {
	read(modelId: EmbeddingModelId): Promise<ArrayBuffer | null>;

	write(modelId: EmbeddingModelId, buffer: ArrayBuffer): Promise<void>;

	remove(modelId: DeprecatedModelId): Promise<boolean>;
}

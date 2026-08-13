import { EmbeddingModelId } from "../types";

export interface EmbeddingFileStore {
	read(modelId: EmbeddingModelId): Promise<ArrayBuffer | null>;

	write(modelId: EmbeddingModelId, buffer: ArrayBuffer): Promise<void>;
}

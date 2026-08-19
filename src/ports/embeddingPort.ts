import { Embedding, EmbeddingModelConfig, EmbeddingModelId } from "../types";

export interface EmbedOptions {
	maxOverlapPercent: number;
	maxChunkSize?: number;
}

export type EmbeddedChunk = {
	embedding: Embedding;
	start: number;
	end: number;
};

export type EmbeddingMetadata = {
	embeddingModelId: EmbeddingModelId;
	maxOverlapPercent: number;
	maxChunkSize?: number;
};

export type EmbeddingResult = {
	chunks: EmbeddedChunk[];
	metadata: EmbeddingMetadata;
};

export type ModelLoadProgress = {
	progress: number;
	file: string;
	loaded: number;
	total: number;
};

export interface EmbeddingPort {
	embed(text: string, options: EmbedOptions): Promise<EmbeddingResult | null>;

	load(config: EmbeddingModelConfig, onProgress?: (progress: ModelLoadProgress) => void, signal?: AbortSignal): Promise<void>;

	unload(): void;
}

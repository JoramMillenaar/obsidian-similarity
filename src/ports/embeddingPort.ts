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

export interface EmbeddingPort {
	embed(text: string, options: EmbedOptions): Promise<EmbeddingResult | null>;

	load(config: EmbeddingModelConfig): Promise<void>;

	unload(): void;
}

import { EmbeddingModelConfig } from "../types";

export interface EmbedOptions {
	maxOverlapPercent: number;
	maxChunkSize?: number;
}

export type EmbeddedChunk = {
	embedding: Float32Array;
	start: number;
	end: number;
};

export interface EmbeddingPort {
	embed(text: string, options: EmbedOptions): Promise<EmbeddedChunk[] | null>;

	load(config: EmbeddingModelConfig): Promise<void>;

	unload(): void;
}

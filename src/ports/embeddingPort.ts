import { Embedding, EmbeddingModelConfig, EmbeddingModelId, EmbeddingQuant } from "../types";

/** Compute backend a model ran inference on. */
export type Device = 'wasm' | 'webgpu';

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
	quant: EmbeddingQuant;
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
	/** Compute backend this port's model is running on, when known. */
	readonly device?: Device;

	embed(text: string, options: EmbedOptions): Promise<EmbeddingResult | null>;

	unload(): Promise<void>;
}

export type LoadEmbeddingPort = (
	config: EmbeddingModelConfig,
	onProgress?: (progress: ModelLoadProgress) => void,
	signal?: AbortSignal,
) => Promise<EmbeddingPort>;

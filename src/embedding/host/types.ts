import { EmbeddingResult, ModelLoadProgress } from "../../ports";

/** Compute backend a model ran inference on. */
export type Device = 'wasm' | 'webgpu';

/** Called with download/init progress while a model loads. */
export type ModelLoadProgressCallback = (progress: ModelLoadProgress) => void;

/** Chunks and embeds a whole document's text, honoring optional overlap and max chunk size. */
export type GenerateDocumentEmbeddings = (text: string, maxOverlapPercent?: number, maxChunkSize?: number) => Promise<EmbeddingResult>;

/** Bookkeeping for one outstanding request sent to the embedding worker, awaiting its response. */
export type PendingWorkerRequest = {
	resolve: (data: EmbeddingResult) => void;
	reject: (error: Error) => void;
	timeoutId: number;
	extendOnAck: boolean;
	acked: boolean;
};

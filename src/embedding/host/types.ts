import { Device, EmbeddingResult, ModelLoadProgress } from "../../ports";

export type { Device };

/** Called with download/init progress while a model loads. */
export type ModelLoadProgressCallback = (progress: ModelLoadProgress) => void;

/** Chunks and embeds a whole document's text, honoring optional overlap and max chunk size. */
export type GenerateDocumentEmbeddings = (text: string, maxOverlapPercent?: number, maxChunkSize?: number) => Promise<EmbeddingResult>;

/** Bookkeeping for one outstanding embed request sent to the embedding worker, awaiting its response. */
export type PendingWorkerRequest = {
	resolve: (data: EmbeddingResult) => void;
	reject: (error: Error) => void;
	timeoutId: number;
	extendOnAck: boolean;
	acked: boolean;
};

/** Bookkeeping for one outstanding dispose request sent to the embedding worker. */
export type PendingDisposeRequest = {
	resolve: () => void;
	reject: (error: Error) => void;
	timeoutId: number;
};

import { EmbeddingModelConfig } from "../../../types";
import { EmbedLane, EmbeddingResult, ModelLoadProgress } from "../../../ports";
import { Device } from "../types";

/** Messages the host sends to the embedding worker. */
export type WorkerRequest =
	| { type: 'init'; config: EmbeddingModelConfig; allowWebGpu: boolean }
	| { type: 'embed'; requestId: number; payload: string; maxOverlapPercent?: number; lane: EmbedLane }
	| { type: 'dispose'; requestId: number };

/** Messages the embedding worker posts back to the host. */
export type WorkerResponse =
	| ({ type: 'model-load-progress' } & ModelLoadProgress)
	| { type: 'model-load-error'; message: string; offline: boolean }
	| { type: 'ready'; device: Device }
	| { type: 'embed-result'; requestId: number; data: EmbeddingResult }
	| { type: 'embed-error'; requestId: number; message: string }
	| { type: 'disposed'; requestId: number };

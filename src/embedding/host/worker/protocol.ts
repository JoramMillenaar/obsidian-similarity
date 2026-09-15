import { EmbeddingModelConfig } from "../../../types";
import { EmbeddingResult } from "../../../ports/embeddingPort";

export type WorkerRequest =
	| { type: 'init'; config: EmbeddingModelConfig }
	| { type: 'embed'; requestId: number; payload: string; maxOverlapPercent?: number; maxChunkSize?: number }
	| { type: 'dispose'; requestId: number };

export type WorkerResponse =
	| { type: 'model-load-progress'; progress: number; file: string; loaded: number; total: number }
	| { type: 'model-load-error'; message: string; offline: boolean }
	| { type: 'ready'; device: string }
	| { type: 'ack'; requestId: number }
	| { type: 'embed-result'; requestId: number; data: EmbeddingResult }
	| { type: 'embed-error'; requestId: number; message: string }
	| { type: 'disposed'; requestId: number };

import { Device, ModelLoadProgress } from "../ports";
import { RerankerModelConfig } from "../types";

/** Messages the host sends to a reranker worker. */
export type RerankerRequest =
	| { type: 'reranker-init'; config: RerankerModelConfig; allowWebGpu: boolean }
	| { type: 'reranker-score'; requestId: number; query: string; passages: string[] }
	| { type: 'reranker-cancel'; requestId: number };

/** Messages a reranker worker posts back. A cancelled score request gets no answer. */
export type RerankerResponse =
	| ({ type: 'reranker-progress' } & ModelLoadProgress)
	| { type: 'reranker-ready'; device: Device }
	| { type: 'reranker-load-error'; message: string }
	| { type: 'reranker-scores'; requestId: number; scores: number[] }
	| { type: 'reranker-score-error'; requestId: number; message: string };

/** The model worker serves both models: this tells the reranker's messages from the embedder's. */
export function isRerankerRequest(message: { type: string }): message is RerankerRequest {
	return message.type.startsWith('reranker-');
}

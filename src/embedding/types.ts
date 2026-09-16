import { EmbeddingModelId } from "../types";
import { EmbeddingPort, ModelLoadProgress } from "../ports";
import { Priority } from "../core/util/priorityQueue";

export type { Priority };

/** Which stage of a model download `EngineStatus`'s "loading" state is in. */
export type LoadPhase = "downloading" | "finalizing";

/** Public snapshot of the engine's model lifecycle, as seen by UI and status consumers. */
export type EngineStatus =
	| { kind: "idle" }
	| { kind: "loading"; modelId: EmbeddingModelId; progress: number | null; phase: LoadPhase }
	| { kind: "ready"; modelId: EmbeddingModelId }
	| { kind: "error"; modelId: EmbeddingModelId; message: string; offline: boolean };

/** Cancels a subscription created via `EngineStateReader.subscribe`. */
export type Unsubscribe = () => void;

/** Read-only view of the engine's status, for consumers that only observe state. */
export type EngineStateReader = {
	status(): EngineStatus;
	subscribe(listener: (status: EngineStatus) => void): Unsubscribe;
};

/** Internal model lifecycle state, including data (embedder instance, epoch) not exposed via `EngineStatus`. */
export type EngineState =
	| { status: "idle" }
	| { status: "loading"; modelId: EmbeddingModelId; epoch: number; progress: ModelLoadProgress | null; phase: LoadPhase }
	| { status: "error"; modelId: EmbeddingModelId; message: string; offline: boolean; epoch: number }
	| { status: "ready"; modelId: EmbeddingModelId; embedder: EmbeddingPort; epoch: number };

/** A single queued embed request awaiting the ready embedder. */
export type Job = {
	priority: Priority;
	sequence: number;
	run: (embedder: EmbeddingPort) => Promise<unknown>;
	settle: () => void;
	cancel: (error: unknown) => void;
};

/** Tracks an in-flight `requestModel` call so duplicate requests for the same model can share it. */
export type PendingModelRequest = { modelId: EmbeddingModelId; promise: Promise<void> };

import { EngineStatus } from "./types";
import { EmbeddingModelId } from "../types";

/** Thrown by `EmbeddingEngine.embed` when called while no model is ready (idle, loading, or errored). */
export class ModelNotReadyError extends Error {
	constructor(readonly status: EngineStatus["kind"]) {
		super(
			status === "idle"
				? "No embedding model is loaded yet."
				: status === "error"
					? "The embedding model failed to load."
					: "A model switch is in progress.",
		);
		this.name = "ModelNotReadyError";
	}
}

/** Thrown when a model load/switch is abandoned because a newer `requestModel` call took over. */
export class ModelRequestSupersededError extends Error {
	constructor(readonly requestedModelId: EmbeddingModelId) {
		super(`Loading ${requestedModelId} was superseded by a newer model request.`);
		this.name = "ModelRequestSupersededError";
	}
}

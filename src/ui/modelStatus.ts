import { EMBEDDING_MODELS } from "../constants";
import { ModelSessionSnapshot } from "../app/modelSession";

export type ModelStatus = {
	ready: boolean;
	message: string;
	processed?: number;
	total?: number;
};

export function getModelStatus(snapshot: ModelSessionSnapshot): ModelStatus {
	if (snapshot.status === "ready") {
		return {ready: true, message: `Active model: ${EMBEDDING_MODELS[snapshot.modelId].label}.`};
	}

	if (snapshot.status === "not-loaded") {
		return {ready: false, message: "No embedding model is loaded yet."};
	}

	const label = EMBEDDING_MODELS[snapshot.targetModelId].label;
	const percent = snapshot.progress ? Math.round(snapshot.progress.progress) : undefined;
	const message = snapshot.phase === "finalizing" ? `Finalizing ${label} model…` : `Downloading ${label} model…`;
	return {
		ready: false,
		message: snapshot.progress ? message : `Loading ${label} model…`,
		processed: percent,
		total: percent !== undefined ? 100 : undefined,
	};
}

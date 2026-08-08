import { EmbeddingModelId } from "../types";

type ModelSessionState =
	| { status: "ready"; modelId: EmbeddingModelId }
	| { status: "switching"; from: EmbeddingModelId; to: EmbeddingModelId };

export class ModelSession {
	private state: ModelSessionState;

	constructor(initialModelId: EmbeddingModelId) {
		this.state = {status: "ready", modelId: initialModelId};
	}

	current(): EmbeddingModelId {
		if (this.state.status === "switching") {
			throw new Error("No embedding model is available: a model switch is in progress.");
		}
		return this.state.modelId;
	}

	isSwitching(): boolean {
		return this.state.status === "switching";
	}

	hydrate(modelId: EmbeddingModelId): void {
		this.state = {status: "ready", modelId};
	}

	beginSwitch(to: EmbeddingModelId): void {
		if (this.state.status === "switching") {
			throw new Error("An embedding model change is already in progress.");
		}
		this.state = {status: "switching", from: this.state.modelId, to};
	}

	completeSwitch(): void {
		if (this.state.status !== "switching") return;
		this.state = {status: "ready", modelId: this.state.to};
	}

	abortSwitch(): void {
		if (this.state.status !== "switching") return;
		this.state = {status: "ready", modelId: this.state.from};
	}
}

import { EmbeddingModelId } from "../types";
import { ModelLoadProgress, SettingsRepository, StatusReporter } from "../ports";
import { EMBEDDING_MODELS } from "../constants";
import { IndexingWorker } from "./indexingWorker";
import { BuildGenerationUseCase, Generation } from "./generation";

type SessionStatus = "not-loaded" | "loading";

type SessionState =
	| { status: "not-loaded" }
	| { status: "loading"; targetModelId: EmbeddingModelId; epoch: number; progress: ModelLoadProgress | null; phase: "downloading" | "finalizing" }
	| { status: "ready"; generation: Generation; epoch: number };

type PendingRequest = { modelId: EmbeddingModelId; promise: Promise<void> };

export class ModelNotReadyError extends Error {
	constructor(readonly status: SessionStatus) {
		super(
			status === "not-loaded"
				? "No embedding model is loaded yet."
				: "A model switch is in progress.",
		);
	}
}

export class ModelRequestSupersededError extends Error {
	constructor(readonly requestedModelId: EmbeddingModelId) {
		super(`Loading ${requestedModelId} was superseded by a newer model request.`);
	}
}

export type ModelSessionSnapshot =
	| { status: "not-loaded" }
	| { status: "loading"; targetModelId: EmbeddingModelId; progress: ModelLoadProgress | null; phase: "downloading" | "finalizing" }
	| { status: "ready"; modelId: EmbeddingModelId };

export type ModelStateReader = {
	getSnapshot(): ModelSessionSnapshot;
	subscribe(listener: (snapshot: ModelSessionSnapshot) => void): () => void;
};

type ModelSessionDeps = {
	buildGeneration: BuildGenerationUseCase;
	worker: IndexingWorker;
	indexStorage: { flush(): Promise<void> };
	settingsRepo: SettingsRepository;
	status: StatusReporter;
};

export class ModelSession implements ModelStateReader {
	private state: SessionState = {status: "not-loaded"};
	private epoch = 0;
	private abortController: AbortController | null = null;
	private pending: PendingRequest | null = null;
	private readonly listeners = new Set<(snapshot: ModelSessionSnapshot) => void>();

	constructor(private readonly deps: ModelSessionDeps) {
	}

	getSnapshot(): ModelSessionSnapshot {
		if (this.state.status === "ready") return {status: "ready", modelId: this.state.generation.modelId};
		if (this.state.status === "loading") {
			return {status: "loading", targetModelId: this.state.targetModelId, progress: this.state.progress, phase: this.state.phase};
		}
		return {status: "not-loaded"};
	}

	subscribe(listener: (snapshot: ModelSessionSnapshot) => void): () => void {
		this.listeners.add(listener);
		listener(this.getSnapshot());
		return () => {
			this.listeners.delete(listener);
		};
	}

	private notify(): void {
		const snapshot = this.getSnapshot();
		for (const listener of this.listeners) {
			try {
				listener(snapshot);
			} catch (error) {
				console.error("[Similarity] Model session listener failed:", error);
			}
		}
	}

	async withGeneration<T>(fn: (generation: Generation) => Promise<T>): Promise<T> {
		if (this.state.status !== "ready") throw new ModelNotReadyError(this.state.status);
		return await fn(this.state.generation);
	}

	requestModel(modelId: EmbeddingModelId): Promise<void> {
		if (this.state.status === "ready" && this.state.generation.modelId === modelId) return Promise.resolve();

		if (this.pending?.modelId === modelId) return this.pending.promise;

		const pending: PendingRequest = {modelId, promise: Promise.resolve()};
		pending.promise = this.runRequest(modelId).finally(() => {
			if (this.pending === pending) this.pending = null;
		});
		this.pending = pending;
		return pending.promise;
	}

	shutdown(): void {
		this.epoch++;
		this.abortController?.abort();
		this.abortController = null;
		this.pending = null;
		if (this.state.status === "ready") this.state.generation.unload();
		this.state = {status: "not-loaded"};
		this.listeners.clear();
	}

	private async runRequest(modelId: EmbeddingModelId): Promise<void> {
		this.abortController?.abort();
		const controller = new AbortController();
		this.abortController = controller;
		const epoch = ++this.epoch;

		const outgoing = this.state.status === "ready" ? this.state.generation : null;

		this.state = {status: "loading", targetModelId: modelId, epoch, progress: null, phase: "downloading"};
		this.notify();

		await this.deps.worker.pause();
		await this.deps.worker.reset();
		await this.deps.indexStorage.flush();
		outgoing?.unload();

		if (epoch !== this.epoch) throw new ModelRequestSupersededError(modelId);

		const config = EMBEDDING_MODELS[modelId];
		this.deps.status.update(`Loading ${config.label} model…`);
		const loadStartedAt = Date.now();

		let generation: Generation;
		try {
			generation = await this.deps.buildGeneration(modelId, config, (progress) => {
				const phase: "downloading" | "finalizing" = progress.progress >= 100 ? "finalizing" : "downloading";
				if (epoch === this.epoch && this.state.status === "loading") {
					this.state = {...this.state, progress, phase};
					this.notify();
				}
				if (Date.now() - loadStartedAt < 1000) return;
				this.deps.status.update(
					phase === "finalizing" ? `Finalizing ${config.label} model…` : `Downloading ${config.label} model…`,
				);
			}, controller.signal);
		} catch (error) {
			if (epoch !== this.epoch) throw new ModelRequestSupersededError(modelId);

			this.state = {status: "not-loaded"};
			this.notify();
			this.deps.worker.resume();
			this.deps.status.update(`Failed to load ${config.label}.`, 4000);
			throw error;
		}

		if (epoch !== this.epoch) {
			generation.unload();
			throw new ModelRequestSupersededError(modelId);
		}

		const label = outgoing ? "Switched to" : "Loaded";
		this.state = {status: "ready", generation, epoch};
		this.notify();
		await this.deps.settingsRepo.updatePartial({embeddingModelId: modelId});

		this.deps.worker.resume();
		this.deps.status.update(`${label} ${config.label}.`, 4000);

		void generation.synchronizeIndex();
	}
}

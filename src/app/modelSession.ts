import { EmbeddingModelConfig, EmbeddingModelId } from "../types";
import { ModelLoadProgress, SettingsRepository, StatusReporter } from "../ports";
import { EMBEDDING_MODELS, MIN_DOWNLOAD_PROGRESS_BYTES } from "../constants";
import { IndexingWorker } from "./indexingWorker";
import { BuildGenerationUseCase, Generation } from "./generation";

type SessionStatus = "not-loaded" | "loading" | "error";

type SessionState =
	| { status: "not-loaded" }
	| { status: "loading"; targetModelId: EmbeddingModelId; epoch: number; progress: ModelLoadProgress | null; phase: "downloading" | "finalizing" }
	| { status: "error"; modelId: EmbeddingModelId; message: string; offline: boolean; epoch: number }
	| { status: "ready"; generation: Generation; epoch: number };

type PendingRequest = { modelId: EmbeddingModelId; promise: Promise<void> };

export class ModelNotReadyError extends Error {
	constructor(readonly status: SessionStatus) {
		super(
			status === "not-loaded"
				? "No embedding model is loaded yet."
				: status === "error"
					? "The embedding model failed to load."
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
	| { status: "error"; modelId: EmbeddingModelId; message: string; offline: boolean }
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
		if (this.state.status === "error") {
			return {status: "error", modelId: this.state.modelId, message: this.state.message, offline: this.state.offline};
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

	retry(): Promise<void> {
		if (this.state.status !== "error") return Promise.resolve();
		return this.requestModel(this.state.modelId);
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
		// The model we can fall back to: it is already downloaded, so restoring it works offline.
		const previousModelId = outgoing?.modelId ?? null;

		this.state = {status: "loading", targetModelId: modelId, epoch, progress: null, phase: "downloading"};
		this.notify();

		await this.deps.worker.pause();
		await this.deps.worker.reset();
		await this.deps.indexStorage.flush();
		outgoing?.unload();

		if (epoch !== this.epoch) throw new ModelRequestSupersededError(modelId);

		const config = EMBEDDING_MODELS[modelId];
		this.deps.status.update(`Loading ${config.label} model…`);

		let generation: Generation;
		try {
			generation = await this.loadGeneration(modelId, config, epoch, controller.signal);
		} catch (error) {
			if (epoch !== this.epoch) throw new ModelRequestSupersededError(modelId);

			await this.recoverFromFailedLoad(modelId, previousModelId, error, epoch, controller.signal);
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

	private loadGeneration(
		modelId: EmbeddingModelId,
		config: EmbeddingModelConfig,
		epoch: number,
		signal: AbortSignal,
	): Promise<Generation> {
		return this.deps.buildGeneration(modelId, config, (progress) => {
			if (progress.total < MIN_DOWNLOAD_PROGRESS_BYTES) return;

			const phase: "downloading" | "finalizing" = progress.progress >= 100 ? "finalizing" : "downloading";
			if (epoch === this.epoch && this.state.status === "loading") {
				this.state = {...this.state, progress, phase};
				this.notify();
			}
			this.deps.status.update(
				phase === "finalizing" ? `Finalizing ${config.label} model…` : `Downloading ${config.label} model…`,
			);
		}, signal);
	}

	/**
	 * A switch that fails must not leave the user with nothing: the model they were already using is
	 * cached, so it can be brought back even while offline. Only a first-ever load (nothing cached,
	 * no previous model) genuinely has no way out — that is what the error state is for.
	 */
	private async recoverFromFailedLoad(
		modelId: EmbeddingModelId,
		previousModelId: EmbeddingModelId | null,
		error: unknown,
		epoch: number,
		signal: AbortSignal,
	): Promise<void> {
		const config = EMBEDDING_MODELS[modelId];
		const message = error instanceof Error ? error.message : String(error);

		if (previousModelId !== null && previousModelId !== modelId) {
			const previousConfig = EMBEDDING_MODELS[previousModelId];
			this.state = {status: "loading", targetModelId: previousModelId, epoch, progress: null, phase: "downloading"};
			this.notify();
			this.deps.status.update(`Restoring ${previousConfig.label} model…`);

			try {
				const restored = await this.loadGeneration(previousModelId, previousConfig, epoch, signal);
				if (epoch !== this.epoch) {
					restored.unload();
					throw new ModelRequestSupersededError(modelId);
				}

				this.state = {status: "ready", generation: restored, epoch};
				this.notify();
				this.deps.worker.resume();
				this.deps.status.update(`Could not load ${config.label} — kept ${previousConfig.label}.`, 6000);
				void restored.synchronizeIndex();
				return;
			} catch (restoreError) {
				if (restoreError instanceof ModelRequestSupersededError) throw restoreError;
				if (epoch !== this.epoch) throw new ModelRequestSupersededError(modelId);
				console.error(`[Similarity] Could not restore ${previousConfig.label} after a failed switch:`, restoreError);
			}
		}

		this.failWith(modelId, message, epoch);
	}

	private failWith(modelId: EmbeddingModelId, message: string, epoch: number): void {
		// Park the failure in the state instead of falling back to "not-loaded": the UI would
		// otherwise keep telling the user the model is still on its way, forever.
		this.state = {
			status: "error",
			modelId,
			message,
			offline: typeof navigator !== "undefined" && navigator.onLine === false,
			epoch,
		};
		this.notify();
		this.deps.worker.resume();
		this.deps.status.update(`Failed to load ${EMBEDDING_MODELS[modelId].label}.`, 4000);
	}
}

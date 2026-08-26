import { EmbeddingModelConfig, EmbeddingModelId } from "../types";
import { EmbeddingPort, EmbeddingResult, LoadEmbeddingPort, ModelLoadProgress, SettingsRepository, StatusReporter } from "../ports";
import { EMBEDDING_MODELS, MIN_DOWNLOAD_PROGRESS_BYTES } from "../constants";
import { Priority } from "../core/util/priorityQueue";

export type { Priority };

export type LoadPhase = "downloading" | "finalizing";

export type EngineStatus =
	| { kind: "idle" }
	| { kind: "loading"; modelId: EmbeddingModelId; progress: number | null; phase: LoadPhase }
	| { kind: "ready"; modelId: EmbeddingModelId }
	| { kind: "error"; modelId: EmbeddingModelId; message: string; offline: boolean };

export type Unsubscribe = () => void;

export type EngineStateReader = {
	status(): EngineStatus;
	subscribe(listener: (status: EngineStatus) => void): Unsubscribe;
};

export class ModelNotReadyError extends Error {
	constructor(readonly status: EngineStatus["kind"]) {
		super(
			status === "idle"
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

type EngineState =
	| { status: "idle" }
	| { status: "loading"; modelId: EmbeddingModelId; epoch: number; progress: ModelLoadProgress | null; phase: LoadPhase }
	| { status: "error"; modelId: EmbeddingModelId; message: string; offline: boolean; epoch: number }
	| { status: "ready"; modelId: EmbeddingModelId; embedder: EmbeddingPort; epoch: number };

type Job = {
	priority: Priority;
	sequence: number;
	run: (embedder: EmbeddingPort) => Promise<unknown>;
	settle: () => void;
	cancel: (error: unknown) => void;
};

type PendingRequest = { modelId: EmbeddingModelId; promise: Promise<void> };

const RANK: Record<Priority, number> = {high: 2, medium: 1, low: 0};

export type EmbeddingEngineDeps = {
	loadEmbedder: LoadEmbeddingPort;
	settingsRepo: SettingsRepository;
	status: StatusReporter;
};

export type EmbedOptions = {
	priority?: Priority;
	maxChunkSize?: number;
};

export class EmbeddingEngine {
	private state: EngineState = {status: "idle"};
	private epoch = 0;
	private abortController: AbortController | null = null;
	private pending: PendingRequest | null = null;
	private disposed = false;

	private readonly queue: Job[] = [];
	private sequence = 0;
	private running: Promise<void> | null = null;
	private inFlight: Promise<void> | null = null;

	private readonly listeners = new Set<(status: EngineStatus) => void>();

	constructor(private readonly deps: EmbeddingEngineDeps) {
	}

	status(): EngineStatus {
		const state = this.state;
		if (state.status === "ready") return {kind: "ready", modelId: state.modelId};
		if (state.status === "loading") {
			return {
				kind: "loading",
				modelId: state.modelId,
				progress: state.progress?.progress ?? null,
				phase: state.phase,
			};
		}
		if (state.status === "error") {
			return {kind: "error", modelId: state.modelId, message: state.message, offline: state.offline};
		}
		return {kind: "idle"};
	}

	subscribe(listener: (status: EngineStatus) => void): Unsubscribe {
		this.listeners.add(listener);
		listener(this.status());
		return () => {
			this.listeners.delete(listener);
		};
	}

	embed(text: string, options: EmbedOptions = {}): Promise<EmbeddingResult | null> {
		if (this.disposed) return Promise.reject(new Error("The embedding engine has been disposed."));
		if (this.state.status !== "ready") return Promise.reject(new ModelNotReadyError(this.state.status));

		const {maxOverlapPercent} = this.deps.settingsRepo.get();

		return new Promise<EmbeddingResult | null>((resolve, reject) => {
			this.enqueue({
				priority: options.priority ?? "medium",
				sequence: this.sequence++,
				run: async (embedder) => {
					const result = await embedder.embed(text, {
						maxOverlapPercent,
						maxChunkSize: options.maxChunkSize,
					});
					resolve(result && result.chunks.length > 0 ? result : null);
				},
				settle: () => undefined,
				cancel: reject,
			});
		});
	}

	requestModel(modelId: EmbeddingModelId): Promise<void> {
		if (this.state.status === "ready" && this.state.modelId === modelId) return Promise.resolve();
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

	dispose(): void {
		this.disposed = true;
		this.epoch++;
		this.abortController?.abort();
		this.abortController = null;
		this.pending = null;
		this.cancelQueued("The embedding engine has been disposed.");
		if (this.state.status === "ready") this.state.embedder.unload();
		this.state = {status: "idle"};
		this.listeners.clear();
	}

	private notify(): void {
		const status = this.status();
		for (const listener of this.listeners) {
			try {
				listener(status);
			} catch (error) {
				console.error("[Similarity] Engine status listener failed:", error);
			}
		}
	}

	private enqueue(job: Job): void {
		let insertAt = this.queue.length;
		for (let i = 0; i < this.queue.length; i++) {
			if (RANK[this.queue[i].priority] < RANK[job.priority]) {
				insertAt = i;
				break;
			}
		}
		this.queue.splice(insertAt, 0, job);
		this.ensureRunning();
	}

	private ensureRunning(): void {
		if (this.running || this.disposed) return;
		if (this.state.status !== "ready" || this.queue.length === 0) return;

		this.running = this.drain().finally(() => {
			this.running = null;
			this.ensureRunning();
		});
	}

	private async drain(): Promise<void> {
		while (!this.disposed && this.state.status === "ready" && this.queue.length > 0) {
			const job = this.queue.shift();
			if (!job) return;

			const embedder = this.state.embedder;
			const run = job.run(embedder).then(() => undefined, (error) => {
				job.cancel(error);
			});
			this.inFlight = run;

			try {
				await run;
				job.settle();
			} finally {
				this.inFlight = null;
			}
		}
	}

	private cancelQueued(message: string): void {
		const cancelled = this.queue.splice(0);
		for (const job of cancelled) job.cancel(new Error(message));
	}

	private async runRequest(modelId: EmbeddingModelId): Promise<void> {
		this.abortController?.abort();
		const controller = new AbortController();
		this.abortController = controller;
		const epoch = ++this.epoch;

		const outgoing = this.state.status === "ready" ? this.state.embedder : null;
		const previousModelId = this.state.status === "ready" ? this.state.modelId : null;

		this.state = {status: "loading", modelId, epoch, progress: null, phase: "downloading"};
		this.notify();

		this.cancelQueued("The embedding model is being switched.");
		await this.inFlight;
		outgoing?.unload();

		if (epoch !== this.epoch) throw new ModelRequestSupersededError(modelId);

		const config = EMBEDDING_MODELS[modelId];
		this.deps.status.update(`Loading ${config.label} model…`);

		let embedder: EmbeddingPort;
		try {
			embedder = await this.load(modelId, config, epoch, controller.signal);
		} catch (error) {
			if (epoch !== this.epoch) throw new ModelRequestSupersededError(modelId);

			void this.recoverFromFailedLoad(modelId, previousModelId, error, epoch, controller.signal)
				.catch((recoveryError) => {
					if (recoveryError instanceof ModelRequestSupersededError) return;
					console.error("[Similarity] Recovering from a failed model load failed:", recoveryError);
				});
			throw error;
		}

		if (epoch !== this.epoch) {
			embedder.unload();
			throw new ModelRequestSupersededError(modelId);
		}

		const label = outgoing ? "Switched to" : "Loaded";
		this.state = {status: "ready", modelId, embedder, epoch};
		this.notify();
		await this.deps.settingsRepo.updatePartial({embeddingModelId: modelId});

		this.deps.status.update(`${label} ${config.label}.`, 4000);
		this.ensureRunning();
	}

	private load(
		modelId: EmbeddingModelId,
		config: EmbeddingModelConfig,
		epoch: number,
		signal: AbortSignal,
	): Promise<EmbeddingPort> {
		return this.deps.loadEmbedder(config, (progress) => {
			if (progress.total < MIN_DOWNLOAD_PROGRESS_BYTES) return;

			const phase: LoadPhase = progress.progress >= 100 ? "finalizing" : "downloading";
			if (epoch === this.epoch && this.state.status === "loading") {
				this.state = {...this.state, progress, phase};
				this.notify();
			}
			this.deps.status.update(
				phase === "finalizing" ? `Finalizing ${config.label} model…` : `Downloading ${config.label} model…`,
			);
		}, signal);
	}

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
			this.state = {status: "loading", modelId: previousModelId, epoch, progress: null, phase: "downloading"};
			this.notify();
			this.deps.status.update(`Restoring ${previousConfig.label} model…`);

			try {
				const restored = await this.load(previousModelId, previousConfig, epoch, signal);
				if (epoch !== this.epoch) {
					restored.unload();
					throw new ModelRequestSupersededError(modelId);
				}

				this.state = {status: "ready", modelId: previousModelId, embedder: restored, epoch};
				this.notify();
				this.deps.status.update(`Could not load ${config.label} — kept ${previousConfig.label}.`, 6000);
				this.ensureRunning();
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
		this.state = {
			status: "error",
			modelId,
			message,
			offline: typeof navigator !== "undefined" && navigator.onLine === false,
			epoch,
		};
		this.notify();
		this.cancelQueued("The embedding model failed to load.");
		this.deps.status.update(`Failed to load ${EMBEDDING_MODELS[modelId].label}.`, 4000);
	}
}

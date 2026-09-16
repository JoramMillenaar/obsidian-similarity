import { EmbeddingModelConfig, EmbeddingModelId } from "../types";
import { EmbeddingPort, EmbeddingResult, LoadEmbeddingPort, SettingsRepository, StatusReporter } from "../ports";
import { EMBEDDING_MODELS, MIN_DOWNLOAD_PROGRESS_BYTES } from "../constants";
import { ModelNotReadyError, ModelRequestSupersededError } from "./errors";
import {
	EngineState,
	EngineStatus,
	Job,
	LoadPhase,
	PendingModelRequest,
	Priority,
	Unsubscribe,
} from "./types";

export type { EngineStatus, LoadPhase, Unsubscribe, EngineStateReader, Priority } from "./types";
export { ModelNotReadyError, ModelRequestSupersededError } from "./errors";

const RANK: Record<Priority, number> = {high: 2, medium: 1, low: 0};

/** Collaborators the engine needs to load models, read settings, and report progress to the user. */
export type EmbeddingEngineDeps = {
	loadEmbedder: LoadEmbeddingPort;
	settingsRepo: SettingsRepository;
	status: StatusReporter;
};

/**
 * Per-call tuning for {@link EmbeddingEngine.embed}. Distinct from `ports`' `EmbedOptions`
 * (the lower-level, `EmbeddingPort`-facing shape) — named differently so the two don't get
 * imported interchangeably.
 */
export type EmbedRequestOptions = {
	priority?: Priority;
	maxChunkSize?: number;
};

/**
 * Owns the lifecycle of the active embedding model (loading, switching, recovering from
 * failure) and serializes embed requests against it through a priority queue.
 */
export class EmbeddingEngine {
	private state: EngineState = {status: "idle"};
	private epoch = 0;
	private abortController: AbortController | null = null;
	private pending: PendingModelRequest | null = null;
	private disposed = false;

	private readonly queue: Job[] = [];
	private running: Promise<void> | null = null;
	private inFlight: Promise<void> | null = null;

	private loadGate: Promise<void> = Promise.resolve();

	private readonly listeners = new Set<(status: EngineStatus) => void>();

	constructor(private readonly deps: EmbeddingEngineDeps) {
	}

	/** Current model/loading state, for callers that just need a snapshot. */
	status(): EngineStatus {
		const state = this.state;
		if (state.status === "ready") {
			return state.embedder.device !== undefined
				? {kind: "ready", modelId: state.modelId, device: state.embedder.device}
				: {kind: "ready", modelId: state.modelId};
		}
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

	/** Registers a listener for status changes; it is invoked immediately with the current status. */
	subscribe(listener: (status: EngineStatus) => void): Unsubscribe {
		this.listeners.add(listener);
		listener(this.status());
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Queues `text` for embedding by the ready model, resolving with `null` if it produced no chunks. */
	embed(text: string, options: EmbedRequestOptions = {}): Promise<EmbeddingResult | null> {
		if (this.disposed) return Promise.reject(new Error("The embedding engine has been disposed."));
		if (this.state.status !== "ready") return Promise.reject(new ModelNotReadyError(this.state.status));

		const {maxOverlapPercent} = this.deps.settingsRepo.get();

		return new Promise<EmbeddingResult | null>((resolve, reject) => {
			this.enqueue({
				priority: options.priority ?? "medium",
				run: async (embedder) => {
					const result = await embedder.embed(text, {
						maxOverlapPercent,
						maxChunkSize: options.maxChunkSize,
					});
					resolve(result && result.chunks.length > 0 ? result : null);
				},
				cancel: reject,
			});
		});
	}

	/** Loads and switches to `modelId`, superseding any in-flight switch and falling back to the previous model on failure. */
	requestModel(modelId: EmbeddingModelId): Promise<void> {
		if (this.state.status === "ready" && this.state.modelId === modelId) return Promise.resolve();
		if (this.pending?.modelId === modelId) return this.pending.promise;

		const pending: PendingModelRequest = {modelId, promise: Promise.resolve()};
		pending.promise = this.runRequest(modelId).finally(() => {
			if (this.pending === pending) this.pending = null;
		});
		this.pending = pending;
		return pending.promise;
	}

	/** Re-attempts loading the model that's currently in an error state; a no-op otherwise. */
	retry(): Promise<void> {
		if (this.state.status !== "error") return Promise.resolve();
		return this.requestModel(this.state.modelId);
	}

	/** Tears down the engine: cancels queued work, unloads the active model, and stops accepting new requests. */
	dispose(): void {
		this.disposed = true;
		this.epoch++;
		this.abortController?.abort();
		this.abortController = null;
		this.pending = null;
		this.cancelQueued("The embedding engine has been disposed.");
		if (this.state.status === "ready") void this.state.embedder.unload();
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
		await outgoing?.unload();

		const previousGate = this.loadGate;
		let releaseGate!: () => void;
		this.loadGate = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
		let gateOwnedByRecovery = false;

		try {
			await previousGate;

			if (epoch !== this.epoch) throw new ModelRequestSupersededError(modelId);

			const config = EMBEDDING_MODELS[modelId];
			this.deps.status.update(`Loading ${config.label} model…`);

			let embedder: EmbeddingPort;
			try {
				embedder = await this.load(config, epoch, controller.signal);
			} catch (error) {
				if (epoch !== this.epoch) throw new ModelRequestSupersededError(modelId);

				gateOwnedByRecovery = true;
				void this.recoverFromFailedLoad(modelId, previousModelId, error, epoch, controller.signal)
					.catch((recoveryError) => {
						if (recoveryError instanceof ModelRequestSupersededError) return;
						console.error("[Similarity] Recovering from a failed model load failed:", recoveryError);
					})
					.finally(releaseGate);
				throw error;
			}

			if (epoch !== this.epoch) {
				await embedder.unload();
				throw new ModelRequestSupersededError(modelId);
			}

			const label = outgoing ? "Switched to" : "Loaded";
			this.state = {status: "ready", modelId, embedder, epoch};
			this.notify();
			await this.deps.settingsRepo.updatePartial({embeddingModelId: modelId});

			this.deps.status.update(`${label} ${config.label}.`, 4000);
			this.ensureRunning();
		} finally {
			if (!gateOwnedByRecovery) releaseGate();
		}
	}

	private load(
		config: EmbeddingModelConfig,
		epoch: number,
		signal: AbortSignal,
	): Promise<EmbeddingPort> {
		let largestFileTotal = 0;

		return this.deps.loadEmbedder(config, (progress) => {
			if (progress.total < MIN_DOWNLOAD_PROGRESS_BYTES) return;

			if (progress.total < largestFileTotal) return;
			largestFileTotal = progress.total;

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
				const restored = await this.load(previousConfig, epoch, signal);
				if (epoch !== this.epoch) {
					await restored.unload();
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
			offline: typeof navigator !== "undefined" && !navigator.onLine,
			epoch,
		};
		this.notify();
		this.cancelQueued("The embedding model failed to load.");
		this.deps.status.update(`Failed to load ${EMBEDDING_MODELS[modelId].label}.`, 4000);
	}
}

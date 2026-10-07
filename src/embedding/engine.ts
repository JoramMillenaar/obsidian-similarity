import { EmbeddingModelConfig, EmbeddingModelId } from "../types";
import { EmbedLane, EmbeddingPort, EmbeddingResult, LoadEmbeddingPort, SettingsRepository, StatusReporter } from "../ports";
import { EMBEDDING_MODELS, MIN_DOWNLOAD_PROGRESS_BYTES } from "../constants";
import { ModelNotReadyError, ModelRequestSupersededError } from "./errors";
import { EngineState, EngineStatus, LoadPhase, PendingModelRequest, Unsubscribe } from "./types";

export type { EngineStatus, LoadPhase, Unsubscribe, EngineStateReader } from "./types";
export { ModelNotReadyError, ModelRequestSupersededError } from "./errors";

export type EmbeddingEngineDeps = {
	loadEmbedder: LoadEmbeddingPort;
	settingsRepo: SettingsRepository;
	status: StatusReporter;
};

export type EmbedRequestOptions = {
	lane: EmbedLane;
};

/**
 * Owns the lifecycle of the active embedding model (loading, switching, recovering from
 * failure) and hands embed requests to it. Requests are not queued here: the embedder orders
 * them per chunk by lane, and unloading it settles whatever it was still working on.
 *
 * The model can be switched off (see {@link disable}): an override that outranks model requests
 * until {@link enable} lifts it. Whether that is remembered, and where, is the caller's business.
 */
export class EmbeddingEngine {
	private state: EngineState = {status: "idle"};
	private epoch = 0;
	private abortController: AbortController | null = null;
	private pending: PendingModelRequest | null = null;
	private disposed = false;

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
		if (state.status === "disabled") return {kind: "disabled"};
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

	/** Embeds `text` with the ready model, resolving with `null` if it produced no chunks. */
	async embed(text: string, options: EmbedRequestOptions): Promise<EmbeddingResult | null> {
		if (this.disposed) throw new Error("The embedding engine has been disposed.");
		if (this.state.status !== "ready") throw new ModelNotReadyError(this.state.status);

		const {maxOverlapPercent} = this.deps.settingsRepo.get();
		const result = await this.state.embedder.embed(text, {maxOverlapPercent, lane: options.lane});
		return result && result.chunks.length > 0 ? result : null;
	}

	requestModel(modelId: EmbeddingModelId): Promise<void> {
		if (this.state.status === "disabled") return Promise.resolve();
		if (this.state.status === "ready" && this.state.modelId === modelId) return Promise.resolve();
		if (this.pending?.modelId === modelId) return this.pending.promise;

		const pending: PendingModelRequest = {modelId, promise: Promise.resolve()};
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

	async disable(): Promise<void> {
		if (this.disposed || this.state.status === "disabled") return;

		this.epoch++;
		this.abortController?.abort();
		this.abortController = null;
		this.pending = null;

		const outgoing = this.state.status === "ready" ? this.state.embedder : null;
		this.state = {status: "disabled"};
		this.notify();
		this.deps.status.update("Model disabled.", 4000);

		await outgoing?.unload();
	}

	enable(modelId: EmbeddingModelId): Promise<void> {
		if (this.disposed || this.state.status !== "disabled") return Promise.resolve();

		this.state = {status: "idle"};
		this.notify();
		return this.requestModel(modelId);
	}

	dispose(): void {
		this.disposed = true;
		this.epoch++;
		this.abortController?.abort();
		this.abortController = null;
		this.pending = null;
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

	private async runRequest(modelId: EmbeddingModelId): Promise<void> {
		this.abortController?.abort();
		const controller = new AbortController();
		this.abortController = controller;
		const epoch = ++this.epoch;

		const outgoing = this.state.status === "ready" ? this.state.embedder : null;
		const previousModelId = this.state.status === "ready" ? this.state.modelId : null;

		this.state = {status: "loading", modelId, epoch, progress: null, phase: "downloading"};
		this.notify();

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
		this.deps.status.update(`Failed to load ${EMBEDDING_MODELS[modelId].label}.`, 4000);
	}
}

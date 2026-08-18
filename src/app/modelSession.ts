import { EmbeddingModelId } from "../types";
import { ModelLoadProgress, SettingsRepository, StatusReporter } from "../ports";
import { EMBEDDING_MODELS } from "../constants";
import { IndexingWorker } from "./indexingWorker";
import { BuildGenerationUseCase, Generation } from "./generation";

type SessionStatus = "not-loaded" | "loading";

type SessionState =
	| { status: "not-loaded" }
	| { status: "loading"; targetModelId: EmbeddingModelId; token: number; progress: ModelLoadProgress | null }
	| { status: "ready"; generation: Generation; token: number };

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

/**
 * Thrown when a `requestModel` call is replaced by a newer one (or by shutdown). The request did
 * not complete, so it must not resolve — but it did not *fail* either, so callers should stay
 * silent rather than reporting an error the user deliberately caused.
 */
export class ModelRequestSupersededError extends Error {
	constructor(readonly requestedModelId: EmbeddingModelId) {
		super(`Loading ${requestedModelId} was superseded by a newer model request.`);
	}
}

export type ModelSessionSnapshot =
	| { status: "not-loaded" }
	| { status: "loading"; targetModelId: EmbeddingModelId; progress: ModelLoadProgress | null }
	| { status: "ready"; modelId: EmbeddingModelId };

/** What UI consumers need: read the current state and be notified when it changes. Narrower than the full `ModelSession` so views can't reach `requestModel`/`withGeneration`. */
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

/**
 * Owns the one Generation that may be alive at a time. `withGeneration` is the single resolution
 * point every consumer goes through — it resolves the current Generation once per call and fails
 * fast (typed) rather than throwing an ambient error or queueing. `requestModel` is build-then-swap:
 * a superseded request (a newer `requestModel` call landing before this one finishes) cancels this
 * one's in-flight embedder load via AbortSignal and discards its result if it completes anyway.
 */
export class ModelSession implements ModelStateReader {
	private state: SessionState = {status: "not-loaded"};
	private tokenCounter = 0;
	private abortController: AbortController | null = null;
	private pending: PendingRequest | null = null;
	private readonly listeners = new Set<(snapshot: ModelSessionSnapshot) => void>();

	constructor(private readonly deps: ModelSessionDeps) {
	}

	getSnapshot(): ModelSessionSnapshot {
		if (this.state.status === "ready") return {status: "ready", modelId: this.state.generation.modelId};
		if (this.state.status === "loading") {
			return {status: "loading", targetModelId: this.state.targetModelId, progress: this.state.progress};
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

		// Already loading exactly this model: join the in-flight request instead of aborting and
		// restarting a download that can take a minute (e.g. an impatient second Save click).
		if (this.pending?.modelId === modelId) return this.pending.promise;

		const pending: PendingRequest = {modelId, promise: Promise.resolve()};
		pending.promise = this.runRequest(modelId).finally(() => {
			if (this.pending === pending) this.pending = null;
		});
		this.pending = pending;
		return pending.promise;
	}

	/** Aborts any in-flight load and tears down the live Generation. The session is unusable afterwards. */
	shutdown(): void {
		this.tokenCounter++; // invalidates any in-flight request, so its build is discarded and unloaded
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
		const token = ++this.tokenCounter;

		const outgoing = this.state.status === "ready" ? this.state.generation : null;

		// Leave "ready" synchronously, before the first await. The outgoing Generation is about to be
		// torn down, so no reader may resolve it during the quiesce below.
		this.state = {status: "loading", targetModelId: modelId, token, progress: null};
		this.notify();

		await this.deps.worker.pause();
		await this.deps.worker.reset();
		await this.deps.indexStorage.flush();
		outgoing?.unload();

		if (token !== this.tokenCounter) throw new ModelRequestSupersededError(modelId);

		const config = EMBEDDING_MODELS[modelId];
		this.deps.status.update(`Loading ${config.label} model…`);
		const loadStartedAt = Date.now();

		let generation: Generation;
		try {
			generation = await this.deps.buildGeneration(modelId, config, (progress) => {
				if (token === this.tokenCounter && this.state.status === "loading") {
					this.state = {...this.state, progress};
					this.notify();
				}
				if (Date.now() - loadStartedAt < 1000) return;
				this.deps.status.update(`Downloading ${config.label} model… ${Math.round(progress.progress)}%`);
			}, controller.signal);
		} catch (error) {
			// Superseded: the newer request owns state and the worker, and the failure here is just
			// our own abort — surface it as a cancellation so callers stay quiet.
			if (token !== this.tokenCounter) throw new ModelRequestSupersededError(modelId);

			this.state = {status: "not-loaded"};
			this.notify();
			this.deps.worker.resume();
			this.deps.status.update(`Failed to load ${config.label}.`, 4000);
			throw error;
		}

		if (token !== this.tokenCounter) {
			// A newer request superseded us mid-build; its own flow owns publish + resume.
			generation.unload();
			throw new ModelRequestSupersededError(modelId);
		}

		const label = outgoing ? "Switched to" : "Loaded";
		this.state = {status: "ready", generation, token};
		this.notify();
		await this.deps.settingsRepo.updatePartial({embeddingModelId: modelId});

		this.deps.worker.resume();
		this.deps.status.update(`${label} ${config.label}.`, 4000);

		void generation.synchronizeIndex();
	}
}

import { EmbeddingPort, EmbedOptions, EmbeddingResult, LoadEmbeddingPort, ModelLoadProgress } from "../../ports";
import { EmbeddingModelConfig } from "../../types";
import { WorkerRequest, WorkerResponse } from "./worker/protocol";
import { Device, PendingDisposeRequest, PendingWorkerRequest } from "./types";
import { ModelLoadFailedError } from "./errors";

/**
 * Runs the embedding model in a dedicated Worker instead of calling `EmbeddingModel` directly
 * on the main thread. This is load-bearing, not incidental complexity.
 *
 *   - Calling the model directly on the main thread blocks the UI. WASM inference is
 *     synchronous; there is no way to `await` your way out of it once it's running.
 *   - An earlier version of this used a same-origin `<iframe>` instead of a Worker, on the
 *     mistaken assumption that it ran in some kind of isolated context. It doesn't: an iframe
 *     still shares the page's main JS thread and event loop, so synchronous WASM inference
 *     inside it blocked the UI exactly as badly as running it directly would have.
 *
 * There's a second, Obsidian-specific gotcha this depends on: Obsidian's BrowserWindow sets
 * `nodeIntegrationInWorker: true` (confirmed by extracting Obsidian's own app.asar), unlike
 * Electron's default. That means a Worker here still gets a real Node `process` global, which
 * makes `@huggingface/transformers` think it's running server-side and restricts itself to the
 * `cpu` execution provider — silently dropping WebGPU support. esbuild.config.mjs works around
 * this by prepending a snippet that deletes `self.process` from *this worker's own* global scope
 * before any bundled code (including the model library) evaluates. Don't remove that shim without
 * re-testing WebGPU — without it, model loading fails with
 * `Unsupported device: "webgpu". Should be one of: cpu.`
 */
const EMBED_ACK_TIMEOUT_MS = 15000;
const EMBED_TIMEOUT_MS = 300000;
const DISPOSE_TIMEOUT_MS = 10000;
const READY_TIMEOUT_MS = 300000;

function abortError(): Error {
	return new Error("Embedding model load was aborted");
}

/**
 * Owns one Worker's lifecycle: spins it up, waits for it to report ready, sends embed/dispose
 * requests with ack + completion timeouts, and retries embed requests that never got acked.
 */
class WorkerMessenger {
	private worker: Worker | null = null;
	private requestIdCounter = 0;
	private loadError: ModelLoadFailedError | null = null;
	private crashError: Error | null = null;
	private unloaded = false;
	private readonly pendingRequests = new Map<number, PendingWorkerRequest>();
	private readonly pendingDisposals = new Map<number, PendingDisposeRequest>();

	constructor(
		private readonly workerScript: string,
		private readonly modelConfig: EmbeddingModelConfig,
		private readonly onProgress?: (progress: ModelLoadProgress) => void,
	) {}

	/** Creates the worker and waits for it to finish loading the model, rejecting (and cleaning up) on failure or abort. */
	async initialize(signal?: AbortSignal): Promise<Device> {
		if (this.worker) throw new Error("Worker already initialized");
		if (signal?.aborted) throw abortError();

		const blob = new Blob([this.workerScript], {type: 'application/javascript'});
		const url = URL.createObjectURL(blob);
		const worker = new Worker(url);
		URL.revokeObjectURL(url);
		this.worker = worker;
		worker.addEventListener('message', this.onMessageReceived);
		worker.addEventListener('error', this.onWorkerFatalError);

		try {
			return await this.waitForReady(signal);
		} catch (error) {
			await this.unload();
			throw error;
		}
	}

	private waitForReady(signal?: AbortSignal): Promise<Device> {
		return new Promise<Device>((resolve, reject) => {
			const worker = this.worker;
			if (!worker) return reject(new Error("Worker was not created"));

			const timeoutId = window.setTimeout(() => {
				cleanup();
				reject(new ModelLoadFailedError(
					`The ${this.modelConfig.label} model did not finish loading. Check your internet connection and try again.`,
					!window.navigator.onLine,
				));
			}, READY_TIMEOUT_MS);

			const onAbort = () => {
				cleanup();
				reject(abortError());
			};

			const onWorkerError = (event: ErrorEvent) => {
				cleanup();
				reject(new Error(`Embedding worker failed to start: ${event.message}`));
			};

			const onReady = (event: MessageEvent<WorkerResponse>) => {
				const message = event.data;
				if (message.type === 'ready') {
					cleanup();
					resolve(message.device);
				} else if (message.type === 'model-load-error') {
					cleanup();
					const error = new ModelLoadFailedError(message.message, message.offline);
					this.loadError = error;
					reject(error);
				}
			};

			const cleanup = () => {
				window.clearTimeout(timeoutId);
				signal?.removeEventListener('abort', onAbort);
				worker.removeEventListener('error', onWorkerError);
				worker.removeEventListener('message', onReady);
			};

			signal?.addEventListener('abort', onAbort, {once: true});
			worker.addEventListener('error', onWorkerError);
			worker.addEventListener('message', onReady);

			const message: WorkerRequest = {type: 'init', config: this.modelConfig};
			worker.postMessage(message);
		});
	}

	private onMessageReceived = (event: MessageEvent<WorkerResponse>) => {
		const message = event.data;

		if (message.type === 'model-load-progress') {
			this.onProgress?.({progress: message.progress, file: message.file, loaded: message.loaded, total: message.total});
			return;
		}

		if (message.type === 'ready' || message.type === 'model-load-error') {
			// Handled by the one-shot listener in waitForReady().
			return;
		}

		if (message.type === 'ack') {
			this.acknowledge(message.requestId);
			return;
		}

		if (message.type === 'embed-result') {
			const pending = this.pendingRequests.get(message.requestId);
			if (!pending) return;
			this.pendingRequests.delete(message.requestId);
			window.clearTimeout(pending.timeoutId);
			pending.resolve(message.data);
			return;
		}

		if (message.type === 'embed-error') {
			const pending = this.pendingRequests.get(message.requestId);
			if (!pending) return;
			this.pendingRequests.delete(message.requestId);
			window.clearTimeout(pending.timeoutId);
			pending.reject(new Error(`Error from embedding worker: ${message.message}`));
			return;
		}

		if (message.type === 'disposed') {
			const pending = this.pendingDisposals.get(message.requestId);
			if (!pending) return;
			this.pendingDisposals.delete(message.requestId);
			window.clearTimeout(pending.timeoutId);
			pending.resolve();
		}
	};

	/** Fired for an uncaught error in the worker at any point after it's been created, not just while loading. */
	private onWorkerFatalError = (event: ErrorEvent): void => {
		const error = new Error(`Embedding worker crashed: ${event.message}`);
		this.crashError = error;

		for (const pending of this.pendingRequests.values()) {
			window.clearTimeout(pending.timeoutId);
			pending.reject(error);
		}
		this.pendingRequests.clear();

		for (const pending of this.pendingDisposals.values()) {
			window.clearTimeout(pending.timeoutId);
			pending.reject(error);
		}
		this.pendingDisposals.clear();
	};

	private acknowledge(requestId: number): void {
		const pending = this.pendingRequests.get(requestId);
		if (!pending || pending.acked || !pending.extendOnAck) return;

		pending.acked = true;
		window.clearTimeout(pending.timeoutId);
		pending.timeoutId = window.setTimeout(() => {
			if (!this.pendingRequests.delete(requestId)) return;
			pending.reject(new Error(`Embedding request '${requestId}' did not finish in time`));
		}, EMBED_TIMEOUT_MS);
	}

	private trackRequest(
		requestId: number,
		timeoutMs: number,
		timeoutMessage: string,
		extendOnAck: boolean,
	): { promise: Promise<EmbeddingResult>; pending: PendingWorkerRequest } {
		let pending!: PendingWorkerRequest;

		const promise = new Promise<EmbeddingResult>((resolve, reject) => {
			const timeoutId = window.setTimeout(() => {
				if (!this.pendingRequests.delete(requestId)) return;
				reject(new Error(timeoutMessage));
			}, timeoutMs);

			pending = {resolve, reject, timeoutId, extendOnAck, acked: false};
			this.pendingRequests.set(requestId, pending);
		});

		return {promise, pending};
	}

	/** Sends `payload` to the worker to embed, retrying if the request is never acknowledged. */
	async sendMessage(payload: string, maxOverlapPercent: number, maxChunkSize?: number, retries = 3): Promise<EmbeddingResult | null> {
		if (!this.worker) throw new Error("Could not find the embedding worker. Is it loaded?");

		let lastError: unknown;

		for (let attempt = 0; attempt < retries; attempt++) {
			if (this.loadError) throw this.loadError;
			if (this.crashError) throw this.crashError;

			const requestId = this.requestIdCounter++;
			const message: WorkerRequest = {requestId, type: 'embed', payload, maxOverlapPercent, maxChunkSize};
			const request = this.trackRequest(requestId, EMBED_ACK_TIMEOUT_MS, `Request with ID '${requestId}' was never acknowledged`, true);

			this.worker.postMessage(message);

			try {
				return await request.promise;
			} catch (error) {
				lastError = error;
				if (request.pending.acked) throw error;
				console.warn(`[Similarity] Attempt ${attempt + 1} to send an embed request failed: ${error}`);
			}
		}

		throw new Error(`All ${retries} attempts to send the message failed: ${lastError}`);
	}

	/** Asks the worker to dispose the model, then terminates it. Idempotent. */
	async unload(): Promise<void> {
		if (this.unloaded) return;
		this.unloaded = true;

		await this.requestDispose();
		this.detach();
	}

	private async requestDispose(): Promise<void> {
		const worker = this.worker;
		if (!worker || this.loadError || this.crashError) return;

		const requestId = this.requestIdCounter++;
		const promise = new Promise<void>((resolve, reject) => {
			const timeoutId = window.setTimeout(() => {
				if (!this.pendingDisposals.delete(requestId)) return;
				reject(new Error("Worker dispose timed out"));
			}, DISPOSE_TIMEOUT_MS);

			this.pendingDisposals.set(requestId, {resolve, reject, timeoutId});
		});
		const message: WorkerRequest = {requestId, type: 'dispose'};
		worker.postMessage(message);

		try {
			await promise;
		} catch (error) {
			console.warn(`[Similarity] The embedding worker did not confirm disposal: ${error}`);
		}
	}

	private detach(): void {
		for (const pending of this.pendingRequests.values()) {
			window.clearTimeout(pending.timeoutId);
			pending.reject(new Error("Embedding worker was unloaded"));
		}
		this.pendingRequests.clear();

		for (const pending of this.pendingDisposals.values()) {
			window.clearTimeout(pending.timeoutId);
			pending.reject(new Error("Embedding worker was unloaded"));
		}
		this.pendingDisposals.clear();

		this.worker?.removeEventListener('message', this.onMessageReceived);
		this.worker?.removeEventListener('error', this.onWorkerFatalError);
		this.worker?.terminate();
		this.worker = null;
	}
}

/** Adapts a `WorkerMessenger` to the `EmbeddingPort` interface the engine consumes. */
class WorkerEmbeddingProvider implements EmbeddingPort {
	constructor(private readonly messenger: WorkerMessenger) {}

	async embed(text: string, options: EmbedOptions): Promise<EmbeddingResult | null> {
		return await this.messenger.sendMessage(text, options.maxOverlapPercent, options.maxChunkSize);
	}

	unload(): Promise<void> {
		return this.messenger.unload();
	}
}

/** Spins up the embedding worker for `config` and returns an `EmbeddingPort` backed by it. */
export const loadEmbeddingProvider: LoadEmbeddingPort = async (
	config: EmbeddingModelConfig,
	onProgress?: (progress: ModelLoadProgress) => void,
	signal?: AbortSignal,
): Promise<EmbeddingPort> => {
	const messenger = new WorkerMessenger(__WORKER_CONTENTS_PLACEHOLDER__, config, onProgress);
	await messenger.initialize(signal);
	return new WorkerEmbeddingProvider(messenger);
};

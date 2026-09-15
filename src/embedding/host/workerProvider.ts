import { EmbeddingPort, EmbedOptions, EmbeddingResult, LoadEmbeddingPort, ModelLoadProgress } from "../../ports";
import { EmbeddingModelConfig } from "../../types";
import { WorkerRequest, WorkerResponse } from "./worker/protocol";

const EMBED_ACK_TIMEOUT_MS = 15000;
const EMBED_TIMEOUT_MS = 300000;
const DISPOSE_TIMEOUT_MS = 10000;
const READY_TIMEOUT_MS = 300000;

type PendingRequest = {
	resolve: (data: EmbeddingResult) => void;
	reject: (error: Error) => void;
	timeoutId: number;
	extendOnAck: boolean;
	acked: boolean;
};

function abortError(): Error {
	return new Error("Embedding model load was aborted");
}

export class ModelLoadFailedError extends Error {
	constructor(message: string, readonly offline: boolean) {
		super(message);
		this.name = "ModelLoadFailedError";
	}
}

class WorkerMessenger {
	private worker: Worker | null = null;
	private requestIdCounter = 0;
	private loadError: ModelLoadFailedError | null = null;
	private unloaded = false;
	private readonly pendingRequests = new Map<number, PendingRequest>();

	constructor(
		private readonly workerScript: string,
		private readonly modelConfig: EmbeddingModelConfig,
		private readonly onProgress?: (progress: ModelLoadProgress) => void,
	) {}

	async initialize(signal?: AbortSignal): Promise<Device> {
		if (this.worker) throw new Error("Worker already initialized");
		if (signal?.aborted) throw abortError();

		const blob = new Blob([this.workerScript], {type: 'application/javascript'});
		const worker = new Worker(URL.createObjectURL(blob));
		this.worker = worker;
		worker.addEventListener('message', this.onMessageReceived);

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
					resolve(message.device as Device);
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
			const pending = this.pendingRequests.get(message.requestId);
			if (!pending) return;
			this.pendingRequests.delete(message.requestId);
			window.clearTimeout(pending.timeoutId);
			pending.resolve({chunks: [], metadata: {embeddingModelId: this.modelConfig.id, maxOverlapPercent: 0}});
		}
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
	): { promise: Promise<EmbeddingResult>; pending: PendingRequest } {
		let pending!: PendingRequest;

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

	async sendMessage(payload: string, maxOverlapPercent: number, maxChunkSize?: number, retries = 3): Promise<EmbeddingResult | null> {
		if (!this.worker) throw new Error("Could not find the embedding worker. Is it loaded?");

		let lastError: unknown;

		for (let attempt = 0; attempt < retries; attempt++) {
			if (this.loadError) throw this.loadError;

			const requestId = this.requestIdCounter++;
			const message: WorkerRequest = {requestId, type: 'embed', payload, maxOverlapPercent, maxChunkSize};
			const request = this.trackRequest(requestId, EMBED_ACK_TIMEOUT_MS, `Request with ID '${requestId}' was never acknowledged`, true);

			this.worker.postMessage(message);

			try {
				return await request.promise;
			} catch (error) {
				lastError = error;
				if (request.pending.acked) throw error;
				console.warn(`Attempt ${attempt + 1} failed: ${error}`);
			}
		}

		throw new Error(`All ${retries} attempts to send the message failed: ${lastError}`);
	}

	async unload(): Promise<void> {
		if (this.unloaded) return;
		this.unloaded = true;

		await this.requestDispose();
		this.detach();
	}

	private async requestDispose(): Promise<void> {
		const worker = this.worker;
		if (!worker || this.loadError) return;

		const requestId = this.requestIdCounter++;
		const {promise} = this.trackRequest(requestId, DISPOSE_TIMEOUT_MS, "Worker dispose timed out", false);
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

		this.worker?.removeEventListener('message', this.onMessageReceived);
		this.worker?.terminate();
		this.worker = null;
	}
}

type Device = 'wasm' | 'webgpu';

class WorkerEmbeddingProvider implements EmbeddingPort {
	constructor(private readonly messenger: WorkerMessenger) {}

	async embed(text: string, options: EmbedOptions): Promise<EmbeddingResult | null> {
		return await this.messenger.sendMessage(text, options.maxOverlapPercent, options.maxChunkSize);
	}

	unload(): Promise<void> {
		return this.messenger.unload();
	}
}

export const loadEmbeddingProvider: LoadEmbeddingPort = async (
	config: EmbeddingModelConfig,
	onProgress?: (progress: ModelLoadProgress) => void,
	signal?: AbortSignal,
): Promise<EmbeddingPort> => {
	const messenger = new WorkerMessenger(__WORKER_CONTENTS_PLACEHOLDER__, config, onProgress);
	await messenger.initialize(signal);
	return new WorkerEmbeddingProvider(messenger);
};

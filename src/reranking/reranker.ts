import { Device } from "../ports";
import { RerankerModelConfig } from "../types";
import { Unsubscribe } from "../core/util/unsubscribe";
import { MIN_DOWNLOAD_PROGRESS_BYTES } from "../constants";
import { RerankerRequest, RerankerResponse } from "./protocol";

/** What the reranker is doing, as the search modal's toggle shows it. */
export type RerankerStatus =
	| { kind: "unloaded" }
	| { kind: "loading"; progress: number | null }
	| { kind: "ready"; device: Device }
	| { kind: "error"; message: string };

/** Keeps the reranker loaded until released. Releasing twice is harmless. */
export type RerankerLease = { release(): void };

export type RerankerDeps = {
	config: RerankerModelConfig;
	/** Starts a Worker running the model worker bundle. */
	startWorker: () => Worker;
	allowWebGpu: boolean;
	/** How long the model stays loaded after its last lease is released. */
	idleMs: number;
};

type Loading = {
	kind: "loading";
	worker: Worker;
	progress: number | null;
	/** Size of the largest file seen downloading: progress follows that one, the weights. */
	largestFile: number;
	/** Resolves once loading settles, either way. */
	settled: Promise<void>;
	settle: () => void;
};

type Ready = { kind: "ready"; worker: Worker; device: Device };

type State =
	| { kind: "unloaded" }
	| Loading
	| Ready
	| { kind: "error"; message: string };

type PendingScore = {
	resolve: (scores: number[]) => void;
	reject: (error: Error) => void;
};

const MAX_CACHED_SCORES = 2000;

// Where transformers.js keeps what it downloads (see embedding/host/model.ts).
const TRANSFORMERS_CACHE = "transformers-cache";
// The weights the worker loads: fp16 on WebGPU, int8 on the CPU (see reranking/worker.ts).
const WEIGHT_FILES = ["onnx/model_fp16.onnx", "onnx/model_quantized.onnx"];

function abortError(): Error {
	const error = new Error("Reranking was cancelled.");
	error.name = "AbortError";
	return error;
}

/**
 * Owns the cross-encoder that reorders text searches. It loads in a Worker of its own when a
 * search asks for it, and that Worker is terminated once nothing has used the model for
 * {@link RerankerDeps.idleMs}: ending the Worker is the only way to hand back the memory, since
 * a WASM heap never shrinks. Separate from the embedder's worker for the same reason, so it is
 * the one exception to the embedder being the only model: it's loaded on request, and briefly.
 *
 * Users take a lease ({@link acquire}) while they may want scores; the first loads the model,
 * and the idle countdown starts when the last is released.
 */
export class Reranker {
	private state: State = {kind: "unloaded"};
	private leases = 0;
	private idleTimer: number | null = null;
	private requestIdCounter = 0;
	private disposed = false;
	private readonly pending = new Map<number, PendingScore>();
	/** Scores by search and passage, so refreshed results only score what changed. */
	private readonly scores = new Map<string, number>();
	private readonly listeners = new Set<(status: RerankerStatus) => void>();

	constructor(private readonly deps: RerankerDeps) {
	}

	status(): RerankerStatus {
		const state = this.state;
		if (state.kind === "loading") return {kind: "loading", progress: state.progress};
		if (state.kind === "ready") return {kind: "ready", device: state.device};
		if (state.kind === "error") return {kind: "error", message: state.message};
		return {kind: "unloaded"};
	}

	/** Registers a listener for status changes; it is invoked immediately with the current status. */
	subscribe(listener: (status: RerankerStatus) => void): Unsubscribe {
		this.listeners.add(listener);
		listener(this.status());
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * Keeps the model loaded until the lease is released, loading it first if it isn't. The first
	 * lease after a failure tries again; later ones leave that to {@link retry}.
	 */
	acquire(): RerankerLease {
		if (this.disposed) return {release: () => {}};

		this.leases++;
		this.cancelTeardown();
		if (this.state.kind === "unloaded" || (this.state.kind === "error" && this.leases === 1)) this.load();

		let released = false;
		return {
			release: () => {
				if (released) return;
				released = true;
				this.leases--;
				if (this.leases === 0) this.scheduleTeardown();
			},
		};
	}

	/** Loads the model again after it failed to, if anyone still holds a lease. */
	retry(): void {
		if (this.state.kind === "error" && this.leases > 0) this.load();
	}

	/** Whether the model's weights are already downloaded, so loading it won't fetch hundreds of megabytes. */
	async isDownloaded(): Promise<boolean> {
		if (this.state.kind === "ready") return true;
		if (typeof caches === "undefined") return false;
		try {
			const cache = await caches.open(TRANSFORMERS_CACHE);
			for (const file of WEIGHT_FILES) {
				if (await cache.match(`https://huggingface.co/${this.deps.config.repoId}/resolve/main/${file}`)) return true;
			}
		} catch {
			// An unreadable cache reads as not downloaded: the cost is asking before a download that wasn't needed.
		}
		return false;
	}

	/**
	 * How relevant each passage is to `query`, 0–1. Waits for the model while it loads; rejects if
	 * it is unloaded or fails meanwhile, or when `signal` fires, which also stops the worker.
	 */
	async score(query: string, passages: string[], signal?: AbortSignal): Promise<number[]> {
		const keys = passages.map((passage) => `${query}\u0000${passage}`);
		const scores = keys.map((key) => this.scores.get(key));
		const missing = scores.flatMap((score, i) => score === undefined ? [i] : []);
		if (missing.length) {
			const fresh = await this.request(query, missing.map((i) => passages[i]), signal);
			missing.forEach((i, at) => {
				scores[i] = fresh[at];
				this.remember(keys[i], fresh[at]);
			});
		}
		return scores as number[];
	}

	/** Terminates the model's worker for good, e.g. when the plugin unloads. */
	dispose(): void {
		this.disposed = true;
		this.cancelTeardown();
		const state = this.state;
		if (state.kind === "loading" || state.kind === "ready") this.stop(state, new Error("The reranker was unloaded."));
		this.state = {kind: "unloaded"};
		this.scores.clear();
		this.listeners.clear();
	}

	private load(): void {
		let settle!: () => void;
		const settled = new Promise<void>((resolve) => {
			settle = resolve;
		});
		const worker = this.deps.startWorker();
		worker.addEventListener("message", (event: MessageEvent<RerankerResponse>) => this.onMessage(worker, event.data));
		worker.addEventListener("error", (event: ErrorEvent) => this.fail(worker, `The reranker crashed: ${event.message}`));

		this.state = {kind: "loading", worker, progress: null, largestFile: 0, settled, settle};
		this.notify();
		this.post(worker, {type: "reranker-init", config: this.deps.config, allowWebGpu: this.deps.allowWebGpu});
	}

	private onMessage(worker: Worker, message: RerankerResponse): void {
		const state = this.state;
		if (!("worker" in state) || state.worker !== worker) return;

		if (message.type === "reranker-progress") {
			if (state.kind !== "loading") return;
			if (message.total < MIN_DOWNLOAD_PROGRESS_BYTES || message.total < state.largestFile) return;
			this.state = {...state, largestFile: message.total, progress: message.progress};
			this.notify();
			return;
		}

		if (message.type === "reranker-ready") {
			if (state.kind !== "loading") return;
			this.state = {kind: "ready", worker, device: message.device};
			this.notify();
			state.settle();
			return;
		}

		if (message.type === "reranker-load-error") {
			this.fail(worker, message.message);
			return;
		}

		const pending = this.pending.get(message.requestId);
		if (!pending) return;
		this.pending.delete(message.requestId);
		if (message.type === "reranker-scores") pending.resolve(message.scores);
		else pending.reject(new Error(`Error from the reranker: ${message.message}`));
	}

	/** Ends a worker that failed. The error stays on show until the next lease (or {@link retry}) loads again. */
	private fail(worker: Worker, message: string): void {
		const state = this.state;
		if (!("worker" in state) || state.worker !== worker) return;
		this.stop(state, new Error(message));
		this.state = {kind: "error", message};
		this.notify();
		if (this.leases === 0) this.scheduleTeardown();
	}

	/** Terminates the worker, failing whatever was still waiting on it. */
	private stop(state: Loading | Ready, reason: Error): void {
		state.worker.terminate();
		for (const pending of this.pending.values()) pending.reject(reason);
		this.pending.clear();
		if (state.kind === "loading") state.settle();
	}

	private async request(query: string, passages: string[], signal?: AbortSignal): Promise<number[]> {
		if (signal?.aborted) throw abortError();
		if (this.state.kind === "loading") await this.state.settled;
		if (signal?.aborted) throw abortError();

		const state = this.state;
		if (state.kind !== "ready") throw new Error(state.kind === "error" ? state.message : "The reranker is not loaded.");

		const requestId = this.requestIdCounter++;
		return new Promise<number[]>((resolve, reject) => {
			const onAbort = () => {
				if (!this.pending.delete(requestId)) return;
				this.post(state.worker, {type: "reranker-cancel", requestId});
				reject(abortError());
			};
			signal?.addEventListener("abort", onAbort, {once: true});
			this.pending.set(requestId, {
				resolve: (scores) => {
					signal?.removeEventListener("abort", onAbort);
					resolve(scores);
				},
				reject: (error) => {
					signal?.removeEventListener("abort", onAbort);
					reject(error);
				},
			});
			this.post(state.worker, {type: "reranker-score", requestId, query, passages});
		});
	}

	private post(worker: Worker, message: RerankerRequest): void {
		worker.postMessage(message);
	}

	private remember(key: string, score: number): void {
		if (this.scores.size >= MAX_CACHED_SCORES) this.scores.delete(this.scores.keys().next().value as string);
		this.scores.set(key, score);
	}

	private scheduleTeardown(): void {
		this.cancelTeardown();
		if (this.disposed) return;
		this.idleTimer = window.setTimeout(() => {
			this.idleTimer = null;
			this.teardown();
		}, this.deps.idleMs);
	}

	private cancelTeardown(): void {
		if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
		this.idleTimer = null;
	}

	private teardown(): void {
		if (this.leases > 0) return;
		const state = this.state;

		// A download cut short starts over next time: let it finish, then wait out the idle time again.
		if (state.kind === "loading") {
			void state.settled.then(() => {
				if (this.leases === 0) this.scheduleTeardown();
			});
			return;
		}

		if (state.kind === "ready") this.stop(state, new Error("The reranker was unloaded."));
		this.scores.clear();
		if (state.kind === "unloaded") return;
		this.state = {kind: "unloaded"};
		this.notify();
	}

	private notify(): void {
		const status = this.status();
		for (const listener of this.listeners) {
			try {
				listener(status);
			} catch (error) {
				console.error("[Similarity] Reranker status listener failed:", error);
			}
		}
	}
}

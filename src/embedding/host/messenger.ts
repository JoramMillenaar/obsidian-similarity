import { EmbeddingResult, ModelLoadProgress } from "../../ports";
import { EmbeddingModelConfig, IframeMessage } from "../../types";

const EMBED_ACK_TIMEOUT_MS = 15000;
const EMBED_TIMEOUT_MS = 300000;
const READY_PING_TIMEOUT_MS = 3000;
const READY_STALL_TIMEOUT_MS = 120000;
const READY_TOTAL_TIMEOUT_MS = 300000;
const MAX_PING_BACKOFF_MS = 5000;

type ProgressMessage = { type: 'model-load-progress'; progress: number; file: string; loaded: number; total: number };
type LoadErrorMessage = { type: 'model-load-error'; message: string; offline: boolean };
type AckMessage = { type: 'ack'; requestId: number };
type ResultMessage = { requestId: number; data: EmbeddingResult; error?: string };
type IncomingMessage = ProgressMessage | LoadErrorMessage | AckMessage | ResultMessage;

type PendingRequest = {
    resolve: (data: EmbeddingResult) => void;
    reject: (error: Error) => void;
    timeoutId: number;
    extendOnAck: boolean;
    acked: boolean;
};

function isProgressMessage(message: IncomingMessage): message is ProgressMessage {
    return 'type' in message && message.type === 'model-load-progress';
}

function isLoadErrorMessage(message: IncomingMessage): message is LoadErrorMessage {
    return 'type' in message && message.type === 'model-load-error';
}

function isAckMessage(message: IncomingMessage): message is AckMessage {
    return 'type' in message && message.type === 'ack';
}

export class ModelLoadFailedError extends Error {
    constructor(message: string, readonly offline: boolean) {
        super(message);
        this.name = "ModelLoadFailedError";
    }
}

function abortError(): Error {
    return new Error("Embedding iframe load was aborted");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortError());
            return;
        }

        const timer = window.setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);

        const onAbort = () => {
            window.clearTimeout(timer);
            reject(abortError());
        };
        signal?.addEventListener('abort', onAbort, {once: true});
    });
}

export class IframeMessenger {
    private iframe: HTMLIFrameElement | null = null;
    private requestIdCounter = 0;
    private lastIframeActivityAt = 0;
    private loadError: ModelLoadFailedError | null = null;
    private pendingRequests = new Map<number, PendingRequest>();

    constructor(
        private iframeId: string,
        private workerScript: string,
        private modelConfig: EmbeddingModelConfig,
        private onProgress?: (progress: ModelLoadProgress) => void,
    ) {}

    async initialize(signal?: AbortSignal): Promise<void> {
        if (this.iframe) return;
        if (signal?.aborted) throw abortError();

		// deliberately document and not activeDocument to prevent attaching to settings window
        this.iframe = document.body.createEl('iframe', {
            attr: {
                id: this.iframeId,
                style: "display: none;",
                srcdoc: this.buildSrcdoc(),
            },
        });

        window.removeEventListener('message', this.onMessageReceived);
        window.addEventListener('message', this.onMessageReceived);

        try {
            await this.waitForIframeReady(signal);
        } catch (error) {
            this.unload();
            throw error;
        }
    }

    private buildSrcdoc(): string {
		// `<` is escaped so the config can't terminate the inline <script> tag it's embedded in.
        const configJson = JSON.stringify(this.modelConfig).replace(/</g, "\\u003c");
        const configScript = `<script>window.__EMBEDDING_MODEL_CONFIG__ = ${configJson};</script>\n`;
        return configScript + this.workerScript;
    }

    private onMessageReceived = (event: MessageEvent) => {
        if (event.origin !== window.location.origin) return;
        if (event.source !== this.iframe?.contentWindow) return;

        const message = event.data as IncomingMessage;
        this.lastIframeActivityAt = Date.now();

        if (isProgressMessage(message)) {
            this.onProgress?.({ progress: message.progress, file: message.file, loaded: message.loaded, total: message.total });
            return;
        }

        if (isLoadErrorMessage(message)) {
            this.loadError = new ModelLoadFailedError(message.message, message.offline);
            for (const [requestId, pending] of this.pendingRequests) {
                this.pendingRequests.delete(requestId);
                window.clearTimeout(pending.timeoutId);
                pending.reject(this.loadError);
            }
            return;
        }

        if (isAckMessage(message)) {
            this.acknowledge(message.requestId);
            return;
        }

        const { requestId, data, error } = message;
        const pending = this.pendingRequests.get(requestId);

        if (!pending) return;

        this.pendingRequests.delete(requestId);
        window.clearTimeout(pending.timeoutId);

        if (error) {
            pending.reject(new Error(`Error from iframe: ${error}`));
            return;
        }

        pending.resolve(data);
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

    async sendMessage(payload: string, maxOverlapPercent: number, maxChunkSize?: number, retries = 3): Promise<EmbeddingResult | null> {
        if (!this.iframe || !this.iframe.contentWindow) {
            throw new Error("Could not find the Iframe. Is it loaded'?");
        }

        let lastError: unknown;

        for (let attempt = 0; attempt < retries; attempt++) {
            if (this.loadError) throw this.loadError;

            const requestId = this.requestIdCounter++;
            const message: IframeMessage = { requestId, payload, maxOverlapPercent, maxChunkSize };
            const request = this.trackRequest(requestId, EMBED_ACK_TIMEOUT_MS, `Request with ID '${requestId}' was never acknowledged`, true);

            this.iframe?.contentWindow?.postMessage(message, window.origin);

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

            pending = { resolve, reject, timeoutId, extendOnAck, acked: false };
            this.pendingRequests.set(requestId, pending);
        });

        return { promise, pending };
    }

    private async waitForIframeReady(signal?: AbortSignal): Promise<void> {
        this.lastIframeActivityAt = Date.now();

        const startedAt = Date.now();

        for (let attempt = 0; ; attempt++) {
            if (signal?.aborted) throw abortError();
            if (this.loadError) throw this.loadError;
            try {
                await this.ping();
                return;
            } catch {
                if (signal?.aborted) throw abortError();
                const loadError = this.getLoadError();
                if (loadError) throw loadError;

                const silentFor = Date.now() - this.lastIframeActivityAt;
                if (silentFor > READY_STALL_TIMEOUT_MS || Date.now() - startedAt > READY_TOTAL_TIMEOUT_MS) {
                    throw new ModelLoadFailedError(
                        `The ${this.modelConfig.label} model did not finish loading. Check your internet connection and try again.`,
                        !window.navigator.onLine,
                    );
                }
				if (attempt) console.warn(`Iframe ping attempt ${attempt + 1} failed. Retrying...`);
                await sleep(Math.min(1000 * 2 ** attempt, MAX_PING_BACKOFF_MS), signal);
            }
        }
    }

    private getLoadError(): ModelLoadFailedError | null {
        return this.loadError;
    }

    private async ping(): Promise<void> {
        if (!this.iframe || !this.iframe.contentWindow) {
            throw new Error("Iframe is not ready");
        }

        const requestId = this.requestIdCounter++;
        const message: IframeMessage = { requestId, payload: "ping" };
        const { promise } = this.trackRequest(requestId, READY_PING_TIMEOUT_MS, "Ping timed out", false);

        this.iframe.contentWindow.postMessage(message, window.origin);
        await promise;
    }

    unload(): void {
        for (const pending of this.pendingRequests.values()) {
            window.clearTimeout(pending.timeoutId);
            pending.reject(new Error("Embedding iframe was unloaded"));
        }
        this.pendingRequests.clear();

        this.iframe?.remove();
        window.removeEventListener('message', this.onMessageReceived);
        this.iframe = null;
    }
}

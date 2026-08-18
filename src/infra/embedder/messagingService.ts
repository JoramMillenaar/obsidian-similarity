import { EmbeddingResult, ModelLoadProgress } from "../../ports";
import { EmbeddingModelConfig, IframeMessage } from "../../types";

const EMBED_TIMEOUT_MS = 30000;
const READY_PING_TIMEOUT_MS = 3000;
const READY_STALL_TIMEOUT_MS = 120000;

type ProgressMessage = { type: 'model-load-progress'; progress: number; file: string };
type ResultMessage = { requestId: number; data: EmbeddingResult; error?: string };

function isProgressMessage(message: ProgressMessage | ResultMessage): message is ProgressMessage {
    return 'type' in message && message.type === 'model-load-progress';
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
    private pendingRequests = new Map<number, { resolve: (data: EmbeddingResult) => void; reject: (error: Error) => void; timeoutId: number }>();

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
            if (signal?.aborted) this.unload();
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

        const message = event.data as ProgressMessage | ResultMessage;
        this.lastIframeActivityAt = Date.now();

        if (isProgressMessage(message)) {
            this.onProgress?.({ progress: message.progress, file: message.file });
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

    async sendMessage(payload: string, maxOverlapPercent: number, maxChunkSize?: number, retries = 3): Promise<EmbeddingResult | null> {
        if (!this.iframe || !this.iframe.contentWindow) {
            throw new Error("Could not find the Iframe. Is it loaded'?");
        }

        for (let attempt = 0; attempt < retries; attempt++) {
            const requestId = this.requestIdCounter++;
            const message: IframeMessage = { requestId, payload, maxOverlapPercent, maxChunkSize };

            try {
                return await new Promise<EmbeddingResult>((resolve, reject) => {
                    const timeoutId = window.setTimeout(() => {
                        if (this.pendingRequests.has(requestId)) {
                            this.pendingRequests.delete(requestId);
                            reject(new Error(`Request with ID '${requestId}' timed out`));
                        }
                    }, EMBED_TIMEOUT_MS);

                    this.pendingRequests.set(requestId, { resolve, reject, timeoutId });
                    this.iframe?.contentWindow?.postMessage(message, window.origin);
                });
            } catch (error) {
                console.warn(`Attempt ${attempt + 1} failed: ${error}`);
            }
        }

        throw new Error(`All ${retries} attempts to send the message failed`);
    }

    private async waitForIframeReady(signal?: AbortSignal): Promise<void> {
        this.lastIframeActivityAt = Date.now();

        for (let attempt = 0; ; attempt++) {
            if (signal?.aborted) throw abortError();
            try {
                await this.ping();
                return;
            } catch {
                if (signal?.aborted) throw abortError();

                const silentFor = Date.now() - this.lastIframeActivityAt;
                if (silentFor > READY_STALL_TIMEOUT_MS) {
                    throw new Error(
                        `Iframe is not responsive: the embedding model did not load, and the iframe has been silent for ${Math.round(silentFor / 1000)}s`,
                    );
                }
				if (attempt) console.warn(`Iframe ping attempt ${attempt + 1} failed. Retrying...`);
                await sleep(1000, signal);
            }
        }
    }

    private ping(): Promise<void> {
        if (!this.iframe || !this.iframe.contentWindow) {
            return Promise.reject(new Error("Iframe is not ready"));
        }

        return new Promise((resolve, reject) => {
            const requestId = this.requestIdCounter++;
            const message: IframeMessage = { requestId, payload: "ping" };

            const timeoutId = window.setTimeout(() => {
                this.pendingRequests.delete(requestId);
                reject(new Error("Ping timed out"));
            }, READY_PING_TIMEOUT_MS);

            this.pendingRequests.set(requestId, {
                resolve: () => resolve(),
                reject,
                timeoutId,
            });

            this.iframe!.contentWindow!.postMessage(message, window.origin);
        });
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

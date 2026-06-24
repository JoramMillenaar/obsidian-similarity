import { IframeMessage } from "../../../types";

export class IframeMessenger {
    private iframe: HTMLIFrameElement | null = null;
    private requestIdCounter = 0;
    private pendingRequests = new Map<number, { resolve: (data: number[]) => void; reject: (error: Error) => void; timeoutId: number }>();

    constructor(private iframeId: string, private workerScript: string) {}

    async initialize(): Promise<void> {
        if (this.iframe) return;

        const existingIframe = activeDocument.getElementById(this.iframeId) as HTMLIFrameElement | null;
        if (existingIframe) {
            this.iframe = existingIframe;
            return;
        }

        this.iframe = activeDocument.body.createEl('iframe', {
            attr: {
                id: this.iframeId,
                style: "display: none;",
                srcdoc: this.workerScript,
            },
        });

        window.removeEventListener('message', this.onMessageReceived);
        window.addEventListener('message', this.onMessageReceived);

        await this.waitForIframeReady();
    }

    private onMessageReceived = (event: MessageEvent) => {
        if (event.origin !== window.location.origin) return;
        if (event.source !== this.iframe?.contentWindow) return;

        const { requestId, data, error } = event.data as { requestId: number; data: number[]; error?: string };
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

    async sendMessage(payload: string, retries = 3): Promise<number[] | null> {
        if (!this.iframe || !this.iframe.contentWindow) {
            throw new Error("Could not find the Iframe. Is it loaded'?");
        }

        for (let attempt = 0; attempt < retries; attempt++) {
            const requestId = this.requestIdCounter++;
            const message: IframeMessage = { requestId, payload };

            try {
                return await new Promise<number[]>((resolve, reject) => {
                    const timeoutId = window.setTimeout(() => {
                        if (this.pendingRequests.has(requestId)) {
                            this.pendingRequests.delete(requestId);
                            reject(new Error(`Request with ID '${requestId}' timed out`));
                        }
                    }, 10000);

                    this.pendingRequests.set(requestId, { resolve, reject, timeoutId });
                    this.iframe?.contentWindow?.postMessage(message, window.origin);
                });
            } catch (error) {
                console.warn(`Attempt ${attempt + 1} failed: ${error}`);
            }
        }

        throw new Error(`All ${retries} attempts to send the message failed`);
    }

    private async waitForIframeReady(): Promise<void> {
        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                await this.ping();
                return;
            } catch {
				if (attempt) console.warn(`Iframe ping attempt ${attempt + 1} failed. Retrying...`);
                await new Promise((resolve) => window.setTimeout(resolve, 1000));
            }
        }

        throw new Error("Iframe is not responsive after multiple attempts");
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
            }, 3000);

            this.pendingRequests.set(requestId, {
                resolve: () => resolve(),
                reject,
                timeoutId,
            });

            this.iframe!.contentWindow!.postMessage(message, window.origin);
        });
    }

    unload(): void {
        activeDocument.getElementById(this.iframeId)?.remove();
        window.removeEventListener('message', this.onMessageReceived);
    }
}

import { IframeMessenger } from "src/infra/embedder/messagingService";
import { EmbeddingPort, EmbedOptions, EmbeddingResult, ModelLoadProgress } from "../../ports";
import { EmbeddingModelConfig } from "../../types";

let instanceCounter = 0;

/** One-shot: construct, `load(config)` once, `unload()` when done. Never reused across models. */
export class EmbeddingProvider implements EmbeddingPort {
	private readonly iframeId = `related-text-iframe-${instanceCounter++}`;
	private iframeMessenger: IframeMessenger | null = null;

	async load(config: EmbeddingModelConfig, onProgress?: (progress: ModelLoadProgress) => void, signal?: AbortSignal): Promise<void> {
		this.iframeMessenger = new IframeMessenger(this.iframeId, __IFRAME_CONTENTS_PLACEHOLDER__, config, onProgress);
		await this.iframeMessenger.initialize(signal);
	}

	async embed(text: string, options: EmbedOptions): Promise<EmbeddingResult | null> {
		if (!this.iframeMessenger) throw new Error("EmbeddingProvider.embed called before load()");
		return await this.iframeMessenger.sendMessage(text, options.maxOverlapPercent, options.maxChunkSize);
	}

	unload(): void {
		this.iframeMessenger?.unload();
	}
}

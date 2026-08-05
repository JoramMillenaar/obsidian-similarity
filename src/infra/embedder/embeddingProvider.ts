import { IframeMessenger } from "src/infra/embedder/messagingService";
import { EmbeddedChunk, EmbeddingPort, EmbedOptions } from "../../ports";
import { EmbeddingModelConfig } from "../../types";

/** One-shot: construct, `load(config)` once, `unload()` when done. Never reused across models. */
export class EmbeddingProvider implements EmbeddingPort {
	private iframeMessenger: IframeMessenger | null = null;

	async load(config: EmbeddingModelConfig): Promise<void> {
		this.iframeMessenger = new IframeMessenger('related-text-iframe', __IFRAME_CONTENTS_PLACEHOLDER__, config);
		await this.iframeMessenger.initialize();
	}

	async embed(text: string, options: EmbedOptions): Promise<EmbeddedChunk[] | null> {
		if (!this.iframeMessenger) throw new Error("EmbeddingProvider.embed called before load()");
		return await this.iframeMessenger.sendMessage(text, options.maxOverlapPercent);
	}

	unload(): void {
		this.iframeMessenger?.unload();
	}
}

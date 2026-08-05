import { IframeMessenger } from "src/infra/embedder/messagingService";
import { EmbeddedChunk, EmbeddingPort, EmbedOptions } from "../../ports";
import { EmbeddingModelConfig } from "../../types";


export class EmbeddingProvider implements EmbeddingPort {
	private iframeMessenger: IframeMessenger;

	constructor(modelConfig: EmbeddingModelConfig) {
		this.iframeMessenger = new IframeMessenger('related-text-iframe', __IFRAME_CONTENTS_PLACEHOLDER__, modelConfig);
	}

	async load(): Promise<void> {
		await this.iframeMessenger.initialize();
	}

	async embed(text: string, options: EmbedOptions): Promise<EmbeddedChunk[] | null> {
		return await this.iframeMessenger.sendMessage(text, options.maxOverlapPercent);
	}

	unload(): void {
		this.iframeMessenger.unload();
	}
}

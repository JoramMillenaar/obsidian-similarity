import { IframeMessenger } from "src/infra/embedder/iframe/messagingService";
import { EmbeddingPort, EmbedOptions } from "../../ports";


export class EmbeddingProvider implements EmbeddingPort {
	private iframeMessenger: IframeMessenger;

	constructor() {
		this.iframeMessenger = new IframeMessenger('related-text-iframe', __IFRAME_CONTENTS_PLACEHOLDER__);
	}

	async load(): Promise<void> {
		await this.iframeMessenger.initialize();
	}

	async embed(text: string, options: EmbedOptions): Promise<number[][] | null> {
		return await this.iframeMessenger.sendMessage(text, options.maxOverlapPercent);
	}

	unload(): void {
		this.iframeMessenger.unload();
	}
}

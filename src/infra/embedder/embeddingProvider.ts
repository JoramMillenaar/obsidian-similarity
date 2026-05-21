import { IframeMessenger } from "src/infra/embedder/iframe/messagingService";
import { EmbeddingPort } from "../../ports";


export class EmbeddingProvider implements EmbeddingPort {
	private iframeMessenger: IframeMessenger;

	constructor() {
		this.iframeMessenger = new IframeMessenger('related-text-iframe', __IFRAME_CONTENTS_PLACEHOLDER__);
	}

	async load(): Promise<void> {
		await this.iframeMessenger.initialize();
	}

	async embed(text: string): Promise<number[] | null> {
		return await this.iframeMessenger.sendMessage(text);
	}

	unload(): void {
		this.iframeMessenger.unload();
	}
}

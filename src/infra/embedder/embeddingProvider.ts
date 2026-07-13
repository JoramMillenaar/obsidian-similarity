import { IframeMessenger } from "src/infra/embedder/iframe/messagingService";
import { EmbeddingPort } from "../../ports";
import { EmbedOptions } from "../../types";

const DEFAULT_OVERLAP_TOKENS = 32;
const DEFAULT_MAX_CHUNKS = 32;

export class EmbeddingProvider implements EmbeddingPort {
	private iframeMessenger: IframeMessenger;

	constructor() {
		this.iframeMessenger = new IframeMessenger('related-text-iframe', __IFRAME_CONTENTS_PLACEHOLDER__);
	}

	async load(): Promise<void> {
		await this.iframeMessenger.initialize();
	}

	async embed(text: string, options: EmbedOptions = {}): Promise<number[][] | null> {
		return await this.iframeMessenger.sendMessage({
			text,
			overlapTokens: options.overlapTokens ?? DEFAULT_OVERLAP_TOKENS,
			maxChunks: options.maxChunks ?? DEFAULT_MAX_CHUNKS,
		});
	}

	unload(): void {
		this.iframeMessenger.unload();
	}
}

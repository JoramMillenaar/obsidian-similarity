import { IframeMessenger } from "./messenger";
import { EmbeddingPort, EmbedOptions, EmbeddingResult, LoadEmbeddingPort, ModelLoadProgress } from "../../ports";
import { EmbeddingModelConfig } from "../../types";

let instanceCounter = 0;

class EmbeddingProvider implements EmbeddingPort {
	constructor(private readonly iframeMessenger: IframeMessenger) {}

	async embed(text: string, options: EmbedOptions): Promise<EmbeddingResult | null> {
		return await this.iframeMessenger.sendMessage(text, options.maxOverlapPercent, options.maxChunkSize);
	}

	unload(): void {
		this.iframeMessenger.unload();
	}
}

export const loadEmbeddingProvider: LoadEmbeddingPort = async (
	config: EmbeddingModelConfig,
	onProgress?: (progress: ModelLoadProgress) => void,
	signal?: AbortSignal,
): Promise<EmbeddingPort> => {
	const iframeId = `related-text-iframe-${instanceCounter++}`;
	const iframeMessenger = new IframeMessenger(iframeId, __IFRAME_CONTENTS_PLACEHOLDER__, config, onProgress);
	await iframeMessenger.initialize(signal);
	return new EmbeddingProvider(iframeMessenger);
};

import { EmbeddingPort, EmbedOptions, EmbeddingResult } from "../ports";
import { EmbeddingModelId } from "../types";
import { EMBEDDING_MODELS } from "../constants";

// TODO: not sure if this abstraction is still valuable
export class EmbeddingService {
	constructor(private readonly embedder: EmbeddingPort) {
	}

	embed(text: string, options: EmbedOptions): Promise<EmbeddingResult | null> {
		return this.embedder.embed(text, options);
	}

	async swap(modelId: EmbeddingModelId): Promise<void> {
		this.embedder.unload();
		await this.embedder.load(EMBEDDING_MODELS[modelId]);
	}

	unload(): void {
		this.embedder.unload();
	}
}

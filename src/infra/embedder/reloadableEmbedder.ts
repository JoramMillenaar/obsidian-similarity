import { EmbeddingPort, EmbedOptions, EmbeddingResult, ModelLoadProgress } from "../../ports";
import { EmbeddingModelConfig } from "../../types";
import { EmbeddingProvider } from "./embeddingProvider";


export class ReloadableEmbedder implements EmbeddingPort {
	private current: EmbeddingProvider | null = null;

	async load(config: EmbeddingModelConfig, onProgress?: (progress: ModelLoadProgress) => void): Promise<void> {
		await this.reload(config, onProgress);
	}

	async embed(text: string, options: EmbedOptions): Promise<EmbeddingResult | null> {
		if (!this.current) throw new Error("ReloadableEmbedder.embed called before load()");
		return await this.current.embed(text, options);
	}

	unload(): void {
		this.current?.unload();
		this.current = null;
	}

	async reload(config: EmbeddingModelConfig, onProgress?: (progress: ModelLoadProgress) => void): Promise<void> {
		this.current?.unload();
		this.current = new EmbeddingProvider();
		await this.current.load(config, onProgress);
	}
}

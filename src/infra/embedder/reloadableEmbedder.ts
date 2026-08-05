import { EmbeddedChunk, EmbeddingPort, EmbedOptions } from "../../ports";
import { EmbeddingModelConfig } from "../../types";
import { EmbeddingProvider } from "./embeddingProvider";


export class ReloadableEmbedder implements EmbeddingPort {
	private current: EmbeddingProvider;

	constructor(initialConfig: EmbeddingModelConfig) {
		this.current = new EmbeddingProvider(initialConfig);
	}

	async load(): Promise<void> {
		await this.current.load();
	}

	async embed(text: string, options: EmbedOptions): Promise<EmbeddedChunk[] | null> {
		return await this.current.embed(text, options);
	}

	unload(): void {
		this.current.unload();
	}

	async reload(config: EmbeddingModelConfig): Promise<void> {
		this.current.unload();
		this.current = new EmbeddingProvider(config);
		await this.current.load();
	}
}

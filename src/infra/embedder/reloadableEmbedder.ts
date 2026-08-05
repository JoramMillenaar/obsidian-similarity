import { EmbeddedChunk, EmbeddingPort, EmbedOptions } from "../../ports";
import { EmbeddingModelConfig } from "../../types";
import { EmbeddingProvider } from "./embeddingProvider";


export class ReloadableEmbedder implements EmbeddingPort {
	private current: EmbeddingProvider | null = null;

	async load(config: EmbeddingModelConfig): Promise<void> {
		await this.reload(config);
	}

	async embed(text: string, options: EmbedOptions): Promise<EmbeddedChunk[] | null> {
		if (!this.current) throw new Error("ReloadableEmbedder.embed called before load()");
		return await this.current.embed(text, options);
	}

	unload(): void {
		this.current?.unload();
		this.current = null;
	}

	async reload(config: EmbeddingModelConfig): Promise<void> {
		this.current?.unload();
		this.current = new EmbeddingProvider();
		await this.current.load(config);
	}
}

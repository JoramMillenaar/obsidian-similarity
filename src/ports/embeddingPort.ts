import { EmbedOptions } from "../types";

export interface EmbeddingPort {
	embed(text: string, options?: EmbedOptions): Promise<number[][] | null>;

	load(): Promise<void>;

	unload(): void;
}

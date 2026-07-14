export interface EmbedOptions {
	maxOverlapPercent: number;
}

export interface EmbeddingPort {
	embed(text: string, options: EmbedOptions): Promise<number[][] | null>;

	load(): Promise<void>;

	unload(): void;
}

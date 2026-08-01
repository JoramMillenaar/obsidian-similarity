export interface EmbedOptions {
	maxOverlapPercent: number;
}

export type EmbeddedChunk = {
	embedding: number[];
	start: number;
	end: number;
};

export interface EmbeddingPort {
	embed(text: string, options: EmbedOptions): Promise<EmbeddedChunk[] | null>;

	load(): Promise<void>;

	unload(): void;
}

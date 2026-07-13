import { EmbeddingPort, SettingsRepository } from "../ports";

/** Chunks `text` and returns one vector per chunk (already L2-normalized by the model). */
export type EmbedTextChunksUseCase = (text: string) => Promise<number[][] | null>;

export function makeEmbedTextChunks(deps: {
	embedder: EmbeddingPort;
	settingsRepo: SettingsRepository;
}): EmbedTextChunksUseCase {
	return async function embedTextChunks(text: string): Promise<number[][] | null> {
		const settings = await deps.settingsRepo.get();
		const vectors = await deps.embedder.embed(text, {
			overlapTokens: settings.overlap,
			maxChunks: settings.maxChunks,
		});
		if (!vectors || vectors.length === 0) return null;
		return vectors;
	};
}

import { EmbeddedChunk, EmbeddingPort, SettingsRepository } from "../ports";

export type EmbedTextUseCase = (text: string) => Promise<EmbeddedChunk[] | null>;


export function makeEmbedText(deps: {
	embedder: EmbeddingPort;
	settingsRepo: SettingsRepository;
}): EmbedTextUseCase {
	return async function embedText(text: string): Promise<EmbeddedChunk[] | null> {
		const {maxOverlapPercent} = await deps.settingsRepo.get();
		const chunks = await deps.embedder.embed(text, {maxOverlapPercent});
		if (!chunks || chunks.length === 0) return null;
		return chunks;
	};
}

import { EmbeddingPort, EmbeddingResult, SettingsRepository } from "../ports";

export type EmbedTextUseCase = (text: string, maxChunkSize?: number) => Promise<EmbeddingResult | null>;


export function makeEmbedText(deps: {
	embedder: EmbeddingPort;
	settingsRepo: SettingsRepository;
}): EmbedTextUseCase {
	return async function embedText(text: string, maxChunkSize?: number): Promise<EmbeddingResult | null> {
		const {maxOverlapPercent} = deps.settingsRepo.get();
		const result = await deps.embedder.embed(text, {maxOverlapPercent, maxChunkSize});
		if (!result || result.chunks.length === 0) return null;
		return result;
	};
}

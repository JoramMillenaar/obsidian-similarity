import { EmbeddingResult, SettingsRepository } from "../ports";
import { EmbeddingService } from "./embeddingService";

export type EmbedTextUseCase = (text: string, maxChunkSize?: number) => Promise<EmbeddingResult | null>;


export function makeEmbedText(deps: {
	embeddingService: EmbeddingService;
	settingsRepo: SettingsRepository;
}): EmbedTextUseCase {
	return async function embedText(text: string, maxChunkSize?: number): Promise<EmbeddingResult | null> {
		const {maxOverlapPercent} = await deps.settingsRepo.get();
		const result = await deps.embeddingService.embed(text, {maxOverlapPercent, maxChunkSize});
		if (!result || result.chunks.length === 0) return null;
		return result;
	};
}

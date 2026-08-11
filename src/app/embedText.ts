import { EmbeddingResult, SettingsRepository } from "../ports";
import { Priority } from "./jobQueue";
import { EmbeddingService } from "./embeddingService";

export type { Priority };

export type EmbedTextUseCase = (text: string, priority?: Priority, maxChunkSize?: number) => Promise<EmbeddingResult | null>;


export function makeEmbedText(deps: {
	embeddingService: EmbeddingService;
	settingsRepo: SettingsRepository;
}): EmbedTextUseCase {
	return async function embedText(text: string, priority?: Priority, maxChunkSize?: number): Promise<EmbeddingResult | null> {
		const {maxOverlapPercent} = await deps.settingsRepo.get();
		const result = await deps.embeddingService.embed(text, {maxOverlapPercent, maxChunkSize}, priority);
		if (!result || result.chunks.length === 0) return null;
		return result;
	};
}

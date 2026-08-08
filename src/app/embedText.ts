import { EmbeddingPort, EmbeddingResult, SettingsRepository } from "../ports";
import { EmbeddingQueue, Priority } from "./embeddingQueue";
import { hashText } from "../domain/text";

export type { Priority };

export type EmbedTextUseCase = (text: string, priority?: Priority, maxChunkSize?: number) => Promise<EmbeddingResult | null>;


export function makeEmbedText(deps: {
	embedder: EmbeddingPort;
	settingsRepo: SettingsRepository;
	queue: EmbeddingQueue;
}): EmbedTextUseCase {
	return async function embedText(text: string, priority?: Priority, maxChunkSize?: number): Promise<EmbeddingResult | null> {
		const {maxOverlapPercent} = await deps.settingsRepo.get();
		const result = await deps.queue.submit(hashText(text), () => deps.embedder.embed(text, {maxOverlapPercent, maxChunkSize}), priority)
		if (!result || result.chunks.length === 0) return null;
		return result;
	};
}

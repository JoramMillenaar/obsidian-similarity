import { EmbeddedChunk, EmbeddingPort, SettingsRepository } from "../ports";
import { EmbeddingQueue, Priority } from "./embeddingQueue";
import { hashText } from "../domain/text";

export type { Priority };

export type EmbedTextUseCase = (text: string, priority?: Priority) => Promise<EmbeddedChunk[] | null>;


export function makeEmbedText(deps: {
	embedder: EmbeddingPort;
	settingsRepo: SettingsRepository;
	queue: EmbeddingQueue;
}): EmbedTextUseCase {
	return async function embedText(text: string, priority?: Priority): Promise<EmbeddedChunk[] | null> {
		const {maxOverlapPercent} = await deps.settingsRepo.get();
		const chunks = await deps.queue.submit(hashText(text), () => deps.embedder.embed(text, {maxOverlapPercent}), priority)
		if (!chunks || chunks.length === 0) return null;
		return chunks;
	};
}

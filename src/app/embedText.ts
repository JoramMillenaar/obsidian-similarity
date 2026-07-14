import { averageEmbeddings } from "../domain/embedding";
import { EmbeddingPort, SettingsRepository } from "../ports";

export type EmbedTextUseCase = (text: string) => Promise<number[] | null>;

export function makeEmbedText(deps: {
	embedder: EmbeddingPort;
	settingsRepo: SettingsRepository;
}): EmbedTextUseCase {
	return async function embedText(text: string): Promise<number[] | null> {
		const {maxOverlapPercent} = await deps.settingsRepo.get();
		const embeddings = await deps.embedder.embed(text, {maxOverlapPercent});
		if (!embeddings || embeddings.length === 0) return null;
		return averageEmbeddings(embeddings);
	};
}

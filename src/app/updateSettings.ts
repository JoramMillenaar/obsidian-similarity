import { SimilaritySettings } from "../types";
import { SettingsRepository } from "../ports";
import { EmbeddingEngine } from "../embedding/engine";

export type UpdateSettingsUseCase = (patch: Partial<SimilaritySettings>) => Promise<void>;

export function makeUpdateSettings(deps: {
	settingsRepo: SettingsRepository;
	engine: EmbeddingEngine;
	resync: () => Promise<void>;
}): UpdateSettingsUseCase {
	return async function updateSettings(patch) {
		const {embeddingModelId, ...rest} = patch;

		if (Object.keys(rest).length > 0) {
			await deps.settingsRepo.updatePartial(rest);
		}

		// A model switch re-opens the index and resyncs on its own once it is ready.
		if (embeddingModelId !== undefined) {
			await deps.engine.requestModel(embeddingModelId);
			return;
		}

		void deps.resync();
	};
}

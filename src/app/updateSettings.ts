import { EmbeddingModelId, SimilaritySettings } from "../types";
import { SettingsRepository } from "../ports";
import { EmbeddingEngine } from "../embedding/engine";

export type UpdateSettingsUseCase = (patch: Partial<SimilaritySettings>) => Promise<void>;

export function makeUpdateSettings(deps: {
	settingsRepo: SettingsRepository;
	engine: EmbeddingEngine;
	resync: () => Promise<void>;
	switchIndex: (modelId: EmbeddingModelId) => Promise<void>;
}): UpdateSettingsUseCase {
	return async function updateSettings(patch) {
		const {embeddingModelId, ...rest} = patch;

		if (Object.keys(rest).length > 0) {
			await deps.settingsRepo.updatePartial(rest);
		}

		if (embeddingModelId !== undefined) {
			if (deps.engine.status().kind === "disabled") {
				// Nothing to spin up on this device: remember the choice (the engine only records
				// it after a successful load) and serve results from that model's index right away.
				await deps.settingsRepo.updatePartial({embeddingModelId});
				await deps.switchIndex(embeddingModelId);
				return;
			}
			await deps.engine.requestModel(embeddingModelId);
			return;
		}

		void deps.resync();
	};
}

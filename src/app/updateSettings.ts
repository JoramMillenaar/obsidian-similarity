import { SimilaritySettings } from "../types";
import { IndexStorage, SettingsRepository } from "../ports";
import { SynchronizeIndexUseCase } from "./synchronizeIndex";
import { ModelSession } from "../domain/modelSession";
import { ChangeEmbeddingModelUseCase } from "./changeEmbeddingModel";

export type UpdateSettingsUseCase = (patch: Partial<SimilaritySettings>) => Promise<void>;

export function makeUpdateSettings(deps: {
	settingsRepo: SettingsRepository;
	indexStorage: IndexStorage;
	synchronizeIndex: SynchronizeIndexUseCase;
	modelSession: ModelSession;
	changeEmbeddingModel: ChangeEmbeddingModelUseCase;
}): UpdateSettingsUseCase {
	return async function updateSettings(patch) {
		const {embeddingModelId, ...rest} = patch;

		if (Object.keys(rest).length > 0) {
			await deps.settingsRepo.updatePartial(rest);
		}

		if (embeddingModelId !== undefined) {
			await deps.changeEmbeddingModel(embeddingModelId);
			return;
		}

		await deps.indexStorage.repair(deps.modelSession.current());

		void deps.synchronizeIndex();
	};
}

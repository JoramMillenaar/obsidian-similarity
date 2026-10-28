import { DeviceSettingsRepository } from "../ports";
import { EmbeddingEngine } from "../embedding/engine";
import { EMBEDDING_MODEL } from "../constants";

export type SetModelDisabledUseCase = (disabled: boolean) => Promise<void>;

export function makeSetModelDisabled(deps: {
	deviceSettingsRepo: DeviceSettingsRepository;
	engine: EmbeddingEngine;
}): SetModelDisabledUseCase {
	return async function setModelDisabled(disabled) {
		deps.deviceSettingsRepo.updatePartial({modelDisabled: disabled});
		if (disabled) {
			await deps.engine.disable();
		} else {
			await deps.engine.enable(EMBEDDING_MODEL);
		}
	};
}

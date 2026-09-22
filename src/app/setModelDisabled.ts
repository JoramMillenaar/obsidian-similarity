import { DeviceSettingsRepository, SettingsRepository } from "../ports";
import { EmbeddingEngine } from "../embedding/engine";

export type SetModelDisabledUseCase = (disabled: boolean) => Promise<void>;

export function makeSetModelDisabled(deps: {
	deviceSettingsRepo: DeviceSettingsRepository;
	settingsRepo: SettingsRepository;
	engine: EmbeddingEngine;
}): SetModelDisabledUseCase {
	return async function setModelDisabled(disabled) {
		deps.deviceSettingsRepo.updatePartial({modelDisabled: disabled});
		if (disabled) {
			await deps.engine.disable();
		} else {
			await deps.engine.enable(deps.settingsRepo.get().embeddingModelId);
		}
	};
}

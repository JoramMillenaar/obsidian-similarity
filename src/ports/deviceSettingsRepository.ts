import { DeviceSettings } from "../types";

/**
 * Per-device settings. Unlike `SettingsRepository`, nothing here is synced between
 * devices: it is for state that describes *this machine* (e.g. the model is disabled
 * here because it crashes here), not the vault. Backed by synchronous storage.
 */
export interface DeviceSettingsRepository {
	get(): DeviceSettings;

	updatePartial(patch: Partial<DeviceSettings>): void;
}

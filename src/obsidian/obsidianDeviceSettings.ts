import { Plugin } from "obsidian";
import { DeviceSettings } from "../types";
import { DeviceSettingsRepository } from "../ports";
import { DEVICE_SETTINGS_STORAGE_KEY } from "../constants";
import { normalizeDeviceSettings } from "../core/rules/schema";

/**
 * Obsidian's `loadLocalStorage`/`saveLocalStorage` are vault-scoped localStorage:
 * they persist per device and are never synced, which is exactly what device settings need.
 */
export class ObsidianDeviceSettingsRepository implements DeviceSettingsRepository {
	constructor(private readonly plugin: Plugin) {
	}

	get(): DeviceSettings {
		return normalizeDeviceSettings(
			this.plugin.app.loadLocalStorage(DEVICE_SETTINGS_STORAGE_KEY) as Partial<DeviceSettings> | null,
		);
	}

	updatePartial(patch: Partial<DeviceSettings>): void {
		this.plugin.app.saveLocalStorage(DEVICE_SETTINGS_STORAGE_KEY, {...this.get(), ...patch});
	}
}

import { apiVersion, Platform, Plugin } from "obsidian";
import { DeviceInfo } from "../core/feedback";

type NavigatorExtras = Navigator & {
	deviceMemory?: number;
	gpu?: unknown;
};

function describePlatform(): string {
	const parts = [Platform.isMobileApp ? "mobile" : "desktop"];

	if (Platform.isIosApp) parts.push("iOS");
	else if (Platform.isAndroidApp) parts.push("Android");
	else if (Platform.isMacOS) parts.push("macOS");
	else if (Platform.isWin) parts.push("Windows");
	else if (Platform.isLinux) parts.push("Linux");

	if (Platform.isPhone) parts.push("phone");
	else if (Platform.isTablet) parts.push("tablet");

	return parts.join(" ");
}

export function collectDeviceInfo(plugin: Plugin): DeviceInfo {
	const nav = navigator as NavigatorExtras;
	return {
		pluginVersion: plugin.manifest.version,
		obsidianVersion: apiVersion,
		platform: describePlatform(),
		userAgent: nav.userAgent,
		cpuCores: nav.hardwareConcurrency,
		memoryGb: nav.deviceMemory,
		webgpuAvailable: nav.gpu !== undefined,
	};
}

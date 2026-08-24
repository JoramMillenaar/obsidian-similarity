import { SettingsRepository } from "../ports";
import { isPathIgnored } from "../core/rules/ignorePaths";

export type IsIgnoredPath = (path: string) => boolean;

export function makeIsIgnoredPath(deps: {
	settingsRepo: SettingsRepository;
}): IsIgnoredPath {
	return (path: string): boolean => {
		return isPathIgnored(path, deps.settingsRepo.get().ignoredPaths);
	};
}

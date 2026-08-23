import { SettingsRepository } from "../ports";
import { isPathIgnored } from "../domain/ignoreRules";

export type IsIgnoredPath = (path: string) => boolean;

export function makeIsIgnoredPath(deps: {
	settingsRepo: SettingsRepository;
}): IsIgnoredPath {
	return (path: string): boolean => {
		return isPathIgnored(path, deps.settingsRepo.get().ignoredPaths);
	};
}

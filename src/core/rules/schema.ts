import { DeviceSettings, IndexMetadata, ModelIndexFile, SCHEMA_VERSION, SimilarityPluginData, SimilaritySettings } from "../../types";
import { DEFAULT_DEVICE_SETTINGS, DEFAULT_SETTINGS, SEARCH_MODES } from "../../constants";

type StoredSettings = Partial<SimilaritySettings> & {
	lastAppliedMaxExtractedChars?: unknown;
};

export function normalizeSettings(
	value: StoredSettings | undefined,
): SimilaritySettings {
	const ignored = value?.ignoredPaths;
	const searchMode = value?.searchMode;
	const maxRawMarkdownChars = positiveNumber(value?.maxRawMarkdownChars) ?? DEFAULT_SETTINGS.maxRawMarkdownChars;

	let lastAppliedMaxRawMarkdownChars = positiveNumber(value?.lastAppliedMaxRawMarkdownChars) ?? maxRawMarkdownChars;
	const lastAppliedMaxExtractedChars = positiveNumber(value?.lastAppliedMaxExtractedChars);
	if (lastAppliedMaxExtractedChars !== undefined) {
		lastAppliedMaxRawMarkdownChars = Math.min(lastAppliedMaxRawMarkdownChars, lastAppliedMaxExtractedChars);
	}

	return {
		ignoredPaths: Array.isArray(ignored)
			? ignored
			: DEFAULT_SETTINGS.ignoredPaths,
		maxRawMarkdownChars,
		searchMode: typeof searchMode === "string" && SEARCH_MODES.some((mode) => mode.id === searchMode)
			? searchMode
			: DEFAULT_SETTINGS.searchMode,
		lastAppliedMaxRawMarkdownChars,
	};
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && value > 0 ? value : undefined;
}

export function normalizePluginData(
	value: Partial<SimilarityPluginData> | undefined,
): SimilarityPluginData {
	return {settings: normalizeSettings(value?.settings)};
}

export function normalizeDeviceSettings(
	value: Partial<DeviceSettings> | null | undefined,
): DeviceSettings {
	const modelDisabled = value?.modelDisabled;
	return {
		modelDisabled: typeof modelDisabled === "boolean" ? modelDisabled : DEFAULT_DEVICE_SETTINGS.modelDisabled,
	};
}

export function normalizeModelIndexFile(
	value: Partial<ModelIndexFile> | undefined,
): ModelIndexFile {
	const rawIndex = value?.index;
	const index: IndexMetadata = Array.isArray(rawIndex) ? rawIndex : [];
	const schemaVersion = typeof value?.schemaVersion === "number" ? value.schemaVersion : 1;
	const embeddingDim = typeof value?.embeddingDim === "number" && value.embeddingDim >= 0
		? value.embeddingDim
		: 0;

	return {
		schemaVersion: Math.min(schemaVersion, SCHEMA_VERSION),
		embeddingDim,
		index,
	};
}

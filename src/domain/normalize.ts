import { IndexMetadata, ModelIndexFile, SCHEMA_VERSION, SimilarityPluginData, SimilaritySettings } from "../types";
import { DEFAULT_SETTINGS, EMBEDDING_MODELS, MAX_OVERLAP_PERCENT } from "../constants";

export function normalizeSettings(
	value: Partial<SimilaritySettings> | undefined,
): SimilaritySettings {
	const ignored = value?.ignoredPaths;
	const advancedOpen = value?.advancedOpen;
	const maxRawMarkdownChars = value?.maxRawMarkdownChars;
	const maxExtractedChars = value?.maxExtractedChars;
	const maxOverlapPercent = value?.maxOverlapPercent;
	const embeddingModelId = value?.embeddingModelId;

	return {
		ignoredPaths: Array.isArray(ignored)
			? ignored
			: DEFAULT_SETTINGS.ignoredPaths,
		advancedOpen: typeof advancedOpen === "boolean"
			? advancedOpen
			: DEFAULT_SETTINGS.advancedOpen,
		maxRawMarkdownChars: typeof maxRawMarkdownChars === "number" && maxRawMarkdownChars > 0
			? maxRawMarkdownChars
			: DEFAULT_SETTINGS.maxRawMarkdownChars,
		maxExtractedChars: typeof maxExtractedChars === "number" && maxExtractedChars > 0
			? maxExtractedChars
			: DEFAULT_SETTINGS.maxExtractedChars,
		maxOverlapPercent: typeof maxOverlapPercent === "number" && maxOverlapPercent >= 0
			? Math.min(maxOverlapPercent, MAX_OVERLAP_PERCENT)
			: DEFAULT_SETTINGS.maxOverlapPercent,
		embeddingModelId: typeof embeddingModelId === "string" && embeddingModelId in EMBEDDING_MODELS
			? embeddingModelId
			: DEFAULT_SETTINGS.embeddingModelId,
	};
}

export function normalizePluginData(
	value: Partial<SimilarityPluginData> | undefined,
): SimilarityPluginData {
	return {settings: normalizeSettings(value?.settings)};
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

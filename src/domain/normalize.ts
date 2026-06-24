import { SimilarityPluginData, SimilaritySettings } from "../types";
import { DEFAULT_SETTINGS } from "../constants";

export function normalizeSettings(
	value: Partial<SimilaritySettings> | undefined,
): SimilaritySettings {
	const ignored = value?.ignoredPaths;
	const initialIndexCompleted = value?.initialIndexCompleted;
	const advancedOpen = value?.advancedOpen;
	const maxRawMarkdownChars = value?.maxRawMarkdownChars;
	const maxExtractedChars = value?.maxExtractedChars;
	const maxChunks = value?.maxChunks;
	const titleWeight = value?.titleWeight;

	return {
		ignoredPaths: Array.isArray(ignored)
			? ignored
			: DEFAULT_SETTINGS.ignoredPaths,
		initialIndexCompleted: typeof initialIndexCompleted === "boolean"
			? initialIndexCompleted
			: false,
		advancedOpen: typeof advancedOpen === "boolean"
			? advancedOpen
			: DEFAULT_SETTINGS.advancedOpen,
		maxRawMarkdownChars: typeof maxRawMarkdownChars === "number" && maxRawMarkdownChars > 0
			? maxRawMarkdownChars
			: DEFAULT_SETTINGS.maxRawMarkdownChars,
		maxExtractedChars: typeof maxExtractedChars === "number" && maxExtractedChars > 0
			? maxExtractedChars
			: DEFAULT_SETTINGS.maxExtractedChars,
		maxChunks: typeof maxChunks === "number" && maxChunks > 0
			? maxChunks
			: DEFAULT_SETTINGS.maxChunks,
		titleWeight: typeof titleWeight === "number" && titleWeight >= 0
			? titleWeight
			: DEFAULT_SETTINGS.titleWeight,
	};
}

export function normalizePluginData(
	value: Partial<SimilarityPluginData>,
): SimilarityPluginData {
	const index = Array.isArray(value?.index) ? value.index : [];
	const normalizedSettings = normalizeSettings(value?.settings);
	const hasLegacyIndexWithoutFlag =
		typeof value?.settings?.initialIndexCompleted !== "boolean"
		&& index.length > 0;

	return {
		settings: hasLegacyIndexWithoutFlag
			? {
				...normalizedSettings,
				initialIndexCompleted: true,
			}
			: normalizedSettings,
		index,
	};
}

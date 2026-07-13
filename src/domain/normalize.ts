import { IndexV2, SCHEMA_VERSION, SimilarityPluginData, SimilaritySettings } from "../types";
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
	const overlap = value?.overlap;
	const storeAllChunks = value?.storeAllChunks;
	const migrationBannerDismissed = value?.migrationBannerDismissed;

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
		overlap: typeof overlap === "number" && overlap >= 0
			? overlap
			: DEFAULT_SETTINGS.overlap,
		storeAllChunks: typeof storeAllChunks === "boolean"
			? storeAllChunks
			: DEFAULT_SETTINGS.storeAllChunks,
		migrationBannerDismissed: typeof migrationBannerDismissed === "boolean"
			? migrationBannerDismissed
			: DEFAULT_SETTINGS.migrationBannerDismissed,
	};
}

export function normalizePluginData(
	value: Partial<SimilarityPluginData>,
): SimilarityPluginData {
	const index: IndexV2 | SimilarityPluginData["index"] = Array.isArray(value?.index) ? value.index : [];
	const normalizedSettings = normalizeSettings(value?.settings);
	const hasLegacyIndexWithoutFlag =
		typeof value?.settings?.initialIndexCompleted !== "boolean"
		&& index.length > 0;

	// Distinguish a fresh install from an upgrade: an existing install already
	// has an index or has run its initial index. When such a user has never seen
	// the storeAllChunks setting, default them to opt-out (single averaged vector)
	// so their existing store keeps working without a reindex; the migration
	// banner then offers them opt-in.
	const isExistingInstall =
		index.length > 0 || value?.settings?.initialIndexCompleted === true;
	const storeAllChunksAbsent = typeof value?.settings?.storeAllChunks !== "boolean";
	const storeAllChunksOverride = storeAllChunksAbsent && isExistingInstall
		? {storeAllChunks: false}
		: {};

	const schemaVersion = typeof value?.schemaVersion === "number" ? value.schemaVersion : 1;
	const embeddingDim = typeof value?.embeddingDim === "number" && value.embeddingDim >= 0
		? value.embeddingDim
		: 0;

	return {
		settings: {
			...normalizedSettings,
			...(hasLegacyIndexWithoutFlag ? {initialIndexCompleted: true} : {}),
			...storeAllChunksOverride,
		},
		schemaVersion: Math.min(schemaVersion, SCHEMA_VERSION),
		embeddingDim,
		index,
	};
}

import { GraphSettings, SimilarityPluginData, SimilaritySettings } from "../types";
import { DEFAULT_GRAPH_SETTINGS, DEFAULT_SETTINGS } from "../constants";

function normalizePositiveNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: fallback;
}

function normalizeNonNegativeNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: fallback;
}

export function normalizeGraphSettings(
	value: Partial<GraphSettings> | undefined,
): GraphSettings {
	return {
		linksPerNode: Math.round(normalizePositiveNumber(value?.linksPerNode, DEFAULT_GRAPH_SETTINGS.linksPerNode)),
		minScore: typeof value?.minScore === "number" && value.minScore >= 0 && value.minScore <= 1
			? value.minScore
			: DEFAULT_GRAPH_SETTINGS.minScore,
		centerForce: normalizeNonNegativeNumber(value?.centerForce, DEFAULT_GRAPH_SETTINGS.centerForce),
		repelForce: normalizeNonNegativeNumber(value?.repelForce, DEFAULT_GRAPH_SETTINGS.repelForce),
		linkForce: normalizeNonNegativeNumber(value?.linkForce, DEFAULT_GRAPH_SETTINGS.linkForce),
		linkDistance: normalizePositiveNumber(value?.linkDistance, DEFAULT_GRAPH_SETTINGS.linkDistance),
		nodeSize: normalizePositiveNumber(value?.nodeSize, DEFAULT_GRAPH_SETTINGS.nodeSize),
		linkThickness: normalizePositiveNumber(value?.linkThickness, DEFAULT_GRAPH_SETTINGS.linkThickness),
		textFadeThreshold: normalizeNonNegativeNumber(value?.textFadeThreshold, DEFAULT_GRAPH_SETTINGS.textFadeThreshold),
		showOrphans: typeof value?.showOrphans === "boolean"
			? value.showOrphans
			: DEFAULT_GRAPH_SETTINGS.showOrphans,
	};
}

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
		graph: normalizeGraphSettings(value?.graph),
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

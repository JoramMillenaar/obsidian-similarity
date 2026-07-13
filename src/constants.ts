import { SimilaritySettings } from "./types";

export const DEFAULT_SETTINGS: SimilaritySettings = {
	ignoredPaths: [],
	initialIndexCompleted: false,
	advancedOpen: false,
	maxRawMarkdownChars: 20000,
	maxExtractedChars: 4800,
	maxChunks: 32,
	overlap: 32,
	storeAllChunks: true,
	migrationBannerDismissed: false,
};

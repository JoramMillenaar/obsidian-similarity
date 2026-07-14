import { SimilaritySettings } from "./types";

export const MAX_OVERLAP_PERCENT = 50;

export const DEFAULT_SETTINGS: SimilaritySettings = {
	ignoredPaths: [],
	initialIndexCompleted: false,
	advancedOpen: false,
	maxRawMarkdownChars: 20000,
	maxExtractedChars: 4800,
	maxOverlapPercent: 15,
	titleWeight: 3,
};

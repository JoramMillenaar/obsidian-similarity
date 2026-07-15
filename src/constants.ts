import { SimilaritySettings } from "./types";

export const MAX_OVERLAP_PERCENT = 50;

/** Each step costs two embeddings per note, and past this the section is a single sentence anyway. */
export const MAX_CENTROID_SEARCH_STEPS = 8;

export const DEFAULT_SETTINGS: SimilaritySettings = {
	ignoredPaths: [],
	initialIndexCompleted: false,
	advancedOpen: false,
	maxRawMarkdownChars: 20000,
	maxExtractedChars: 4800,
	maxOverlapPercent: 15,
	titleWeight: 3,
	centroidSearchSteps: 4,
};

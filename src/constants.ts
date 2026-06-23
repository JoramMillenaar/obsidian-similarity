import { GraphSettings, SimilaritySettings } from "./types";

export const DEFAULT_GRAPH_SETTINGS: GraphSettings = {
	linksPerNode: 3,
	minScore: 0.25,
	centerForce: 0.3,
	repelForce: 0.5,
	linkForce: 0.4,
	linkDistance: 80,
	nodeSize: 1,
	linkThickness: 1,
	textFadeThreshold: 0.5,
	showOrphans: true,
};

export const DEFAULT_SETTINGS: SimilaritySettings = {
	ignoredPaths: [],
	initialIndexCompleted: false,
	advancedOpen: false,
	maxRawMarkdownChars: 20000,
	maxExtractedChars: 4800,
	maxChunks: 32,
	titleWeight: 3,
	graph: DEFAULT_GRAPH_SETTINGS,
};

import { GraphSettings, SimilaritySettings } from "./types";

export const DEFAULT_GRAPH_SETTINGS: GraphSettings = {
	linksPerNode: 3,
	minScore: 0.25,
	// Force values are multipliers around d3's defaults; 1 reproduces the
	// canonical d3 force-directed graph example (charge -30, link distance 30,
	// forceX/forceY strength 0.1).
	centerForce: 1,
	repelForce: 1,
	linkForce: 1,
	linkDistance: 30,
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

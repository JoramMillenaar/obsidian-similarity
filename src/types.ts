export type Embedding = number[];

export type RawNote = {
	id: string;
	title: string;
	markdown: string;
};

export type NoteIndexCandidate = {
	id: string;
	modifiedAt: number;
	recentOpenRank?: number;
};

export type IndexedNote = {
	id: string;
	embedding: number[];
	contentHash: string,
	updatedAt: string,
};

export type RelatedNote = {
	id: string;
	score: number;
};

export type SimilarityGraphNode = {
	id: string;
	degree: number;
};

export type SimilarityGraphEdge = {
	source: string;
	target: string;
	score: number;
};

export type SimilarityGraph = {
	nodes: SimilarityGraphNode[];
	edges: SimilarityGraphEdge[];
};

export interface IframeMessage {
	requestId: number;
	payload: string;
}

export interface SyncResults {
	indexed: number;
	deleted: number;
}

export type OnProgressCallback = (p: { phase: string; processed: number; total: number }) => void;

export type IndexingPriorityReason = "seed" | "open" | "edit" | "manual";

export type IndexingBannerState = {
	kind: "hidden" | "initial" | "updating" | "failed";
	message: string;
	progressLabel?: string;
	processed: number;
	total: number;
};

export type IndexingQueueSnapshot = {
	isRunning: boolean;
	hasCompletedInitialIndex: boolean;
	currentNoteId?: string;
	pending: number;
	processed: number;
	total: number;
	failed: number;
	fatalError?: string;
	banner: IndexingBannerState;
};

export type IndexingWarning =
	| "raw-markdown-truncated"
	| "prepared-text-truncated"
	| "chunk-limit-reached";

export type PrepareNoteRejectReason =
	| "missing-note"
	| "empty-content"
	| "non-semantic-content";

export type PreparedNoteForEmbedding = {
	noteId: string;
	preparedText: string;
	chunks: string[];
	warnings: IndexingWarning[];
};

export type PrepareNoteResult =
	| {
		status: "ready";
		value: PreparedNoteForEmbedding;
	}
	| {
		status: "reject";
		reason: PrepareNoteRejectReason;
		warnings: IndexingWarning[];
	};

export interface GraphSettings {
	/** Number of most-similar notes connected to each node (N). */
	linksPerNode: number;
	/** Minimum cosine similarity required for an edge to be drawn. */
	minScore: number;
	/** Pull of every node toward the graph center. */
	centerForce: number;
	/** Strength with which nodes push each other apart. */
	repelForce: number;
	/** Tightness of the spring along each edge. */
	linkForce: number;
	/** Natural rest length of each edge. */
	linkDistance: number;
	/** Radius multiplier for nodes. */
	nodeSize: number;
	/** Line-width multiplier for edges. */
	linkThickness: number;
	/** Zoom level below which node labels fade out. */
	textFadeThreshold: number;
	/** Whether to show nodes that have no edges. */
	showOrphans: boolean;
}

export interface SimilaritySettings {
	ignoredPaths: string[];
	initialIndexCompleted: boolean;
	advancedOpen: boolean;
	maxRawMarkdownChars: number;
	maxExtractedChars: number;
	maxChunks: number;
	titleWeight: number;
	graph: GraphSettings;
}

export interface SimilarityPluginData {
	settings: SimilaritySettings;
	index: IndexedNote[];
}

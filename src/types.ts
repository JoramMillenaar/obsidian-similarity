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
	/** One L2-normalized vector per chunk. Length 1 when stored in averaged (opt-out) mode. */
	embeddings: number[][];
	contentHash: string,
	updatedAt: string,
};

export type RelatedNote = {
	id: string;
	score: number;
};

export interface EmbedRequestPayload {
	text: string;
	overlapTokens: number;
	maxChunks: number;
}

export interface IframeMessage {
	requestId: number;
	payload: "ping" | EmbedRequestPayload;
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

export interface EmbedOptions {
	/** Token budget of trailing sentences to repeat at the start of each chunk. */
	overlapTokens?: number;
	/** Maximum number of chunks (and therefore vectors) produced per note. */
	maxChunks?: number;
}

export type PrepareNoteRejectReason =
	| "missing-note"
	| "empty-content"
	| "non-semantic-content";

export type PreparedNoteForEmbedding = {
	noteId: string;
	preparedText: string;
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

export interface SimilaritySettings {
	ignoredPaths: string[];
	initialIndexCompleted: boolean;
	advancedOpen: boolean;
	maxRawMarkdownChars: number;
	maxExtractedChars: number;
	maxChunks: number;
	/** Token budget of sentence-level overlap carried between adjacent chunks. */
	overlap: number;
	/** When true, every chunk vector is stored per note; when false, chunks are averaged into one. */
	storeAllChunks: boolean;
	/** Set once the user has acted on (or dismissed) the per-chunk migration banner. */
	migrationBannerDismissed: boolean;
}

/** Bumped when the on-disk index shape changes. 1 = inline float64 JSON embeddings (legacy). 2 = embeddings in the binary sidecar. */
export const SCHEMA_VERSION = 2;

export type ChunkEntryV2 = {
	/** Index of this chunk's vector in the binary sidecar. */
	row: number;
};

export type IndexEntryV2 = {
	id: string;
	contentHash: string;
	updatedAt: string;
	chunks: ChunkEntryV2[];
};

export type IndexV2 = IndexEntryV2[];

/** The pre-migration on-disk shape: embeddings inline as float64 JSON arrays. */
export type LegacyIndexV1 = IndexedNote[];

export interface SimilarityPluginData {
	settings: SimilaritySettings;
	schemaVersion: number;
	/** Embedding vector length backing the binary sidecar. 0 until first save. */
	embeddingDim: number;
	index: LegacyIndexV1 | IndexV2;
}

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

export type NoteChunk = {
	embedding: number[];
	start: number;
	end: number;
	hash: string;
};

export type IndexedNote = {
	id: string;
	chunks: NoteChunk[];
	contentHash: string,
	updatedAt: string,
	/**
	 * The note's most representative passage, shown as its description.
	 * Undefined until the summarizing pass computes it — indexing never writes
	 * it, so re-indexing a note clears it and it gets recomputed.
	 */
	centroid?: string;
};

export type RelatedNote = {
	id: string;
	score: number;
	/** The note's centroid passage, when one has been computed. */
	centroid?: string;
};

export interface IframeMessage {
	requestId: number;
	payload: string;
	maxOverlapPercent?: number;
}

export interface SyncResults {
	indexed: number;
	deleted: number;
}

export type OnProgressCallback = (p: { phase: string; processed: number; total: number }) => void;

export type IndexingPriorityReason = "seed" | "open" | "edit" | "manual";

export type IndexingBannerState = {
	kind: "hidden" | "initial" | "updating" | "summarizing" | "failed";
	message: string;
	progressLabel?: string;
	processed: number;
	total: number;
};

/** Indexing embeds notes; summarizing derives each note's centroid description afterwards. */
export type IndexingPhase = "indexing" | "summarizing";

export type IndexingQueueSnapshot = {
	isRunning: boolean;
	phase: IndexingPhase;
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
	| "prepared-text-truncated";

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
	/** Clamped 0–50: max share of a chunk's token budget reused as sentence overlap with the previous chunk. */
	maxOverlapPercent: number;
	titleWeight: number;
	/** Binary-search steps used to home in on a note's centroid passage. Each step halves it and costs two embeddings. */
	centroidSearchSteps: number;
}

/** Bumped when the on-disk index shape changes. 1 = inline float64 JSON embeddings (legacy). 2 = embeddings in the binary sidecar. */
export const SCHEMA_VERSION = 2;

export type ChunkEntryV2 = {
	row: number;
	start: number;
	end: number;
	hash: string;
};

export type IndexEntryV2 = {
	id: string;
	contentHash: string;
	updatedAt: string;
	chunks: ChunkEntryV2[];
	/** Optional: absent means the summarizing pass hasn't reached this note yet. */
	centroid?: string;
};

export type IndexV2 = IndexEntryV2[];

/**
 * The v1 on-disk shape: embeddings inline as float64 JSON arrays. Frozen, and
 * deliberately decoupled from IndexedNote so the live type can evolve freely.
 * v1 vectors are never migrated forward — the health check detects them and
 * discards the index so it rebuilds under the current representation.
 */
export type LegacyNoteV1 = {
	id: string;
	embedding: number[];
	contentHash: string;
	updatedAt: string;
};

export type LegacyIndexV1 = LegacyNoteV1[];

export interface SimilarityPluginData {
	settings: SimilaritySettings;
	schemaVersion: number;
	/** Embedding vector length backing the binary sidecar. 0 until first save. */
	embeddingDim: number;
	index: LegacyIndexV1 | IndexV2;
}

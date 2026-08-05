/** Quantized unit-vector embedding: see domain/embedding.ts and domain/embeddingCodec.ts. */
export type Embedding = Int8Array;

export type EmbeddingModelId = "xenova-all-MiniLM-L6-v2";

export type EmbeddingModelConfig = {
	id: EmbeddingModelId;
	repoId: string;
	dim: number;
	maxTokens: number;
};

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
	embedding: Embedding;
	start: number;
	end: number;
	hash: string;
};

export type IndexedNote = {
	id: string;
	chunks: NoteChunk[];
	contentHash: string,
	updatedAt: string,
};

export type RelatedNote = {
	id: string;
	score: number;
};

export interface IframeMessage {
	requestId: number;
	payload: string;
	maxOverlapPercent?: number;
}

export type IndexingQueueSnapshot = {
	isRunning: boolean;
	currentNoteId?: string;
	pending: number;
	processed: number;
	total: number;
	failed: number;
	fatalError?: string;
	failedIds: string[];
};

export const IDLE_INDEXING_SNAPSHOT: IndexingQueueSnapshot = {
	isRunning: false,
	pending: 0,
	processed: 0,
	total: 0,
	failed: 0,
	failedIds: [],
};

export interface SimilaritySettings {
	ignoredPaths: string[];
	advancedOpen: boolean;
	maxRawMarkdownChars: number;
	maxExtractedChars: number;
	maxOverlapPercent: number;
	embeddingModelId: EmbeddingModelId;
}

/** Bumped when the on-disk index shape changes. 1 = inline float64 JSON embeddings (legacy). 2 = embeddings in the binary sidecar. */
export const SCHEMA_VERSION = 2;

export type ChunkMetadata = {
	row: number;
	start: number;
	end: number;
	hash: string;
};

export type NoteIndexMetadata = {
	id: string;
	contentHash: string;
	updatedAt: string;
	chunks: ChunkMetadata[];
};

export type IndexMetadata = NoteIndexMetadata[];

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
	index: LegacyIndexV1 | IndexMetadata;
}

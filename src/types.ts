/** Quantized unit-vector embedding: see domain/embedding.ts and domain/embeddingCodec.ts. */
export type Embedding = Int8Array;

export type EmbeddingModelId =
	| "xenova-all-MiniLM-L6-v2"
	| "xenova-paraphrase-multilingual-MiniLM-L12-v2";

export type EmbeddingModelConfig = {
	id: EmbeddingModelId;
	label: string;
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
	maxChunkSize?: number;
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

export interface SimilarityPluginData {
	settings: SimilaritySettings;
}

export interface ModelIndexFile {
	schemaVersion: number;
	embeddingDim: number;
	index: IndexMetadata;
}

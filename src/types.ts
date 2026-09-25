/** Quantized unit-vector embedding: see domain/embedding.ts and domain/embeddingCodec.ts. */
export type Embedding = Int8Array;

export type EmbeddingModelId =
	| "xenova-all-MiniLM-L6-v2"
	| "xenova-paraphrase-multilingual-MiniLM-L12-v2"
	| "xenova-bge-small-zh-v1.5";

export type PoolingStrategy = "mean" | "cls";

export type EmbeddingQuant = {
	vocab: "q4" | "q8";
	ffn: "fp32" | "fp16" | "q8";
};

export type EmbeddingModelConfig = {
	id: EmbeddingModelId;
	label: string;
	repoId: string;
	dim: number;
	maxTokens: number;
	pooling: PoolingStrategy;
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
	// deprecated
	quant?: EmbeddingQuant,
};

export type RelatedNote = {
	id: string;
	score: number;
};

export type SearchMode = "granular" | "average";

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

export interface SimilaritySettings {
	ignoredPaths: string[];
	advancedOpen: boolean;
	maxRawMarkdownChars: number;
	maxExtractedChars: number;
	maxOverlapPercent: number;
	embeddingModelId: EmbeddingModelId;
	searchMode: SearchMode;
	lastAppliedMaxRawMarkdownChars: number;
	lastAppliedMaxExtractedChars: number;
}

/**
 * Settings that belong to one device and must never follow the vault to another
 * (via Obsidian Sync, iCloud, git, …). Persisted in localStorage, not data.json.
 */
export interface DeviceSettings {
	modelDisabled: boolean;
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
	quant?: EmbeddingQuant;
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

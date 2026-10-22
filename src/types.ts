import type { ScoreNullModel } from "./core/vector/nullModel";

export type Embedding = Int8Array;


export type EmbeddingModelId = "xenova-paraphrase-multilingual-MiniLM-L12-v2-late";

export type DeprecatedModelId =
	| "xenova-all-MiniLM-L6-v2"
	| "xenova-paraphrase-multilingual-MiniLM-L12-v2"
	| "xenova-bge-small-zh-v1.5";

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
	maxOverlapPercent: number;
	minSentenceWords: number;
	/** On the null-corrected score scale (see core/vector/nullModel.ts), like everything below. */
	tierThresholds: TierThresholds;
	/** Results scoring below this are not shown. */
	minScore: number;
	scoreNull: ScoreNullModel;
};

export type TierThresholds = readonly [number, number, number];

export type SimilarityTier = 0 | 1 | 2 | 3;

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
	truncated?: boolean,
};

export type RelatedNote = {
	id: string;
	score: number;
	/** Which comparison scored highest; both share one scale, so the better of the two ranks the note. */
	match: MatchKind;
	tier: SimilarityTier;
	scaledScore: number;
};

/** Precise: the best passage-pair match. Average: the mean over all passage pairs. */
export type MatchKind = "precise" | "average";

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
	maxRawMarkdownChars: number;
	lastAppliedMaxRawMarkdownChars: number;
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
	truncated?: boolean;
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

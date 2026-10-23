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

/** The cross-encoder that reorders text searches on desktop (see reranking/reranker.ts). */
export type RerankerModelConfig = {
	label: string;
	repoId: string;
	/** Search and passage together are cut to this many tokens. */
	maxTokens: number;
	/**
	 * Pairs scored per inference on WebGPU, which is also how soon a cancelled request stops. On the
	 * CPU pairs go one at a time: batching gains nothing there, and a cancel lands sooner.
	 */
	gpuBatchSize: number;
	/** How many of a text search's meaning-based results it reorders on WebGPU (and the search fetches for it). */
	candidates: number;
	/** How many it reorders on the CPU, where each takes about half a second. */
	cpuCandidates: number;
	/** Characters of each note it reads: the matched passage, grown by whole passages around it. */
	passageChars: number;
	/**
	 * That stretch is judged in pieces of whole passages up to this long, so the note's best piece is
	 * known: it ranks the note, and is shown as what matched.
	 */
	pieceChars: number;
	/** Relevance (0–1) at which a reranked result reaches tiers 1, 2 and 3. */
	tierThresholds: TierThresholds;
	/** Reranked results judged less relevant than this are not shown. */
	minRelevance: number;
};

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
	/**
	 * The note's passage the match rests on, in its prepared text: the best pair's for precise, the one
	 * nearest the query's centroid for average, and for a reranked result the piece it judged most relevant.
	 */
	passage?: PassageSpan;
	/** Note queries only: the query note's counterpart, its side of the best pair or its passage nearest this note's centroid. */
	queryPassage?: PassageSpan;
	/**
	 * Text searches only: put first because the note contains (nearly) every distinctive word of the
	 * search. Its score and tier are still the meaning-based ones; `passage` is where the words are.
	 */
	keyword?: boolean;
	/**
	 * Text searches reranked by the cross-encoder only: how relevant it judged the note's passage
	 * to the search, 0–1. Reranked results are ordered by it, and their bar shows it.
	 */
	relevance?: number;
	/** Reranked results only: the text of `passage` as the reranker read it, less the note's title. */
	passageText?: string;
};

export type PassageSpan = Pick<NoteChunk, "start" | "end" | "hash">;

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

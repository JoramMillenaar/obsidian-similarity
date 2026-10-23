import { MULTILINGUAL_LATE_MIN_SCORE, MULTILINGUAL_LATE_NULL, MULTILINGUAL_LATE_TIERS } from "./core/vector/nullModels";
import {
	DeprecatedModelId,
	DeviceSettings,
	EmbeddingModelConfig,
	EmbeddingModelId,
	MatchKind,
	RerankerModelConfig,
	SimilaritySettings,
} from "./types";

export const VIEW_TYPE_SIMILARITY = "similarity";

export const MAX_OVERLAP_PERCENT = 50;

export const MIN_DOWNLOAD_PROGRESS_BYTES = 1_000_000;


export const EMBEDDING_MODEL: EmbeddingModelConfig = {
	id: "xenova-paraphrase-multilingual-MiniLM-L12-v2-late",
	label: "Multilingual",
	repoId: "JoramMillenaar/paraphrase-multilingual-MiniLM-L12-v2-vocab-quantized",
	dim: 384,
	maxTokens: 128,
	maxOverlapPercent: 15,
	minSentenceWords: 6,
	tierThresholds: MULTILINGUAL_LATE_TIERS,
	minScore: MULTILINGUAL_LATE_MIN_SCORE,
	scoreNull: MULTILINGUAL_LATE_NULL,
};

export const EMBEDDING_MODELS: Record<EmbeddingModelId, EmbeddingModelConfig> = {
	[EMBEDDING_MODEL.id]: EMBEDDING_MODEL,
};


/**
 * Reorders text searches, on desktop only. A cross-encoder reads the search and a passage
 * together, so it can tell a passage that answers a question from one that merely shares its
 * topic, which comparing two vectors can't. Too heavy to keep loaded: see reranking/reranker.ts.
 */
export const RERANKER_MODEL: RerankerModelConfig = {
	label: "reranking",
	repoId: "jinaai/jina-reranker-v2-base-multilingual",
	maxTokens: 512,
	gpuBatchSize: 4,
	candidates: 20,
	cpuCandidates: 8,
	passageChars: 700,
	pieceChars: 250,
	// Not yet calibrated on real vaults: in spot checks passages answering the search scored
	// 0.5–0.7, and unrelated ones under 0.08.
	tierThresholds: [0.1, 0.3, 0.6],
	minRelevance: 0.05,
};

/** How long the reranker stays loaded after the last search using it let go of it. */
export const RERANKER_IDLE_MS = 60_000;

export const DEPRECATED_MODEL_IDS: readonly DeprecatedModelId[] = [
	"xenova-all-MiniLM-L6-v2",
	"xenova-paraphrase-multilingual-MiniLM-L12-v2",
	"xenova-bge-small-zh-v1.5",
];

export const MATCH_KINDS: Record<MatchKind, {label: string; desc: string; icon: string}> = {
	precise: {
		label: "Precise match",
		desc: "A passage of this note closely matches a passage of the other.",
		icon: "pilcrow",
	},
	average: {
		label: "Average match",
		desc: "The notes as a whole are about the same thing.",
		icon: "sticky-note",
	},
};

/** Text searches: a note lifted to the top because it contains the words searched for. */
export const KEYWORD_MATCH = {
	label: "Keyword match",
	desc: "This note contains the words you searched for.",
	icon: "text-search",
};

export const DEFAULT_SETTINGS: SimilaritySettings = {
	ignoredPaths: [],
	maxRawMarkdownChars: 20_000,
	lastAppliedMaxRawMarkdownChars: 20_000,
};

export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = {
	modelDisabled: false,
};

export const DEVICE_SETTINGS_STORAGE_KEY = "similarity:device-settings";

export const REPO_URL = "https://github.com/JoramMillenaar/obsidian-similarity";

export const SUPPORT_CONTACT = ["support", "jorammillenaar.com"].join(String.fromCharCode(64));

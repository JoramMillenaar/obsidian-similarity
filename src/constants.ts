import { MULTILINGUAL_LATE_MIN_SCORE, MULTILINGUAL_LATE_NULL, MULTILINGUAL_LATE_TIERS } from "./core/vector/nullModels";
import { DeprecatedModelId, DeviceSettings, EmbeddingModelConfig, EmbeddingModelId, MatchKind, SimilaritySettings } from "./types";

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

import { DeprecatedModelId, DeviceSettings, EmbeddingModelConfig, EmbeddingModelId, SearchMode, SimilaritySettings } from "./types";

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
	minSentenceWords: 5,
	tierThresholds: [0.51, 0.72, 0.90],
};

export const EMBEDDING_MODELS: Record<EmbeddingModelId, EmbeddingModelConfig> = {
	[EMBEDDING_MODEL.id]: EMBEDDING_MODEL,
};


export const DEPRECATED_MODEL_IDS: readonly DeprecatedModelId[] = [
	"xenova-all-MiniLM-L6-v2",
	"xenova-paraphrase-multilingual-MiniLM-L12-v2",
	"xenova-bge-small-zh-v1.5",
];

export const DEFAULT_SEARCH_MODE: SearchMode = "granular";

export const SEARCH_MODES: {id: SearchMode; label: string; desc: string; icon: string}[] = [
	{
		id: "granular",
		label: "precise match",
		desc: "Compares every passage of this note against every passage of each candidate, keeping the best match (default).",
		icon: "locate",
	},
	{
		id: "average",
		label: "average match",
		desc: "Compares the overall averaged meaning of this note against the overall averaged meaning of each candidate.",
		icon: "blend",
	},
];

export const DEFAULT_SETTINGS: SimilaritySettings = {
	ignoredPaths: [],
	maxRawMarkdownChars: 20_000,
	searchMode: DEFAULT_SEARCH_MODE,
	lastAppliedMaxRawMarkdownChars: 20_000,
};

export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = {
	modelDisabled: false,
};

export const DEVICE_SETTINGS_STORAGE_KEY = "similarity:device-settings";

export const REPO_URL = "https://github.com/JoramMillenaar/obsidian-similarity";

export const SUPPORT_CONTACT = ["support", "jorammillenaar.com"].join(String.fromCharCode(64));

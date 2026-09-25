import { DeviceSettings, EmbeddingModelConfig, EmbeddingModelId, SearchMode, SimilaritySettings } from "./types";

export const VIEW_TYPE_SIMILARITY = "similarity";

export const MAX_OVERLAP_PERCENT = 50;

export const MIN_DOWNLOAD_PROGRESS_BYTES = 1_000_000;

export const EMBEDDING_MODELS: Record<EmbeddingModelId, EmbeddingModelConfig> = {
	"xenova-all-MiniLM-L6-v2": {
		id: "xenova-all-MiniLM-L6-v2",
		label: "English",
		repoId: "JoramMillenaar/all-MiniLM-L6-v2-vocab-quantized",
		dim: 384,
		maxTokens: 256,
		pooling: "mean",
	},
	"xenova-paraphrase-multilingual-MiniLM-L12-v2": {
		id: "xenova-paraphrase-multilingual-MiniLM-L12-v2",
		label: "Multilingual (slower)",
		repoId: "JoramMillenaar/paraphrase-multilingual-MiniLM-L12-v2-vocab-quantized",
		dim: 384,
		maxTokens: 128,
		pooling: "mean",
	},
	"xenova-bge-small-zh-v1.5": {
		id: "xenova-bge-small-zh-v1.5",
		label: "Chinese",
		repoId: "JoramMillenaar/bge-small-zh-v1.5-vocab-quantized",
		dim: 512,
		maxTokens: 512,
		pooling: "cls",
	},
};

export const DEFAULT_EMBEDDING_MODEL_ID: EmbeddingModelId = "xenova-all-MiniLM-L6-v2";

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
	advancedOpen: false,
	maxRawMarkdownChars: 20000,
	maxExtractedChars: 4800,
	maxOverlapPercent: 15,
	embeddingModelId: DEFAULT_EMBEDDING_MODEL_ID,
	searchMode: DEFAULT_SEARCH_MODE,
	lastAppliedMaxRawMarkdownChars: 20000,
	lastAppliedMaxExtractedChars: 4800,
};

export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = {
	modelDisabled: false,
};

export const DEVICE_SETTINGS_STORAGE_KEY = "similarity:device-settings";

export const REPO_URL = "https://github.com/JoramMillenaar/obsidian-similarity";

export const SUPPORT_CONTACT = ["support", "jorammillenaar.com"].join(String.fromCharCode(64));

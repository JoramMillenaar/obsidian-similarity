import { DeprecatedModelId, DeviceSettings, EmbeddingModelConfig, SimilaritySettings } from "./types";

export const VIEW_TYPE_SIMILARITY = "similarity";

export const MAX_OVERLAP_PERCENT = 50;

export const CHUNK_OVERLAP_PERCENT = 15;

export const MIN_DOWNLOAD_PROGRESS_BYTES = 1_000_000;

export const EMBEDDING_MODEL: EmbeddingModelConfig = {
	id: "xenova-paraphrase-multilingual-MiniLM-L12-v2",
	label: "Multilingual",
	repoId: "JoramMillenaar/paraphrase-multilingual-MiniLM-L12-v2-vocab-quantized",
	dim: 384,
	maxTokens: 128,
	pooling: "mean",
	tierThresholds: [0.51, 0.72, 0.90],
};

export const DEPRECATED_MODEL_IDS: readonly DeprecatedModelId[] = [
	"xenova-all-MiniLM-L6-v2",
	"xenova-bge-small-zh-v1.5",
];

export const DEFAULT_SETTINGS: SimilaritySettings = {
	ignoredPaths: [],
	advancedOpen: false,
	maxRawMarkdownChars: 20000,
	lastAppliedMaxRawMarkdownChars: 20000,
};

export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = {
	modelDisabled: false,
};

export const DEVICE_SETTINGS_STORAGE_KEY = "similarity:device-settings";

export const REPO_URL = "https://github.com/JoramMillenaar/obsidian-similarity";

export const SUPPORT_CONTACT = ["support", "jorammillenaar.com"].join(String.fromCharCode(64));

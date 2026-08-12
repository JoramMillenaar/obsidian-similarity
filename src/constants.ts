import { EmbeddingModelConfig, EmbeddingModelId, SimilaritySettings } from "./types";

export const MAX_OVERLAP_PERCENT = 50;

export const EMBEDDING_MODELS: Record<EmbeddingModelId, EmbeddingModelConfig> = {
	"xenova-all-MiniLM-L6-v2": {
		id: "xenova-all-MiniLM-L6-v2",
		label: "English only (faster)",
		repoId: "Xenova/all-MiniLM-L6-v2",
		dim: 384,
		maxTokens: 256,
		pooling: "mean",
	},
	"xenova-paraphrase-multilingual-MiniLM-L12-v2": {
		id: "xenova-paraphrase-multilingual-MiniLM-L12-v2",
		label: "Multilingual (slower)",
		repoId: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
		dim: 384,
		maxTokens: 128,
		pooling: "mean",
	},
	"xenova-bge-small-zh-v1.5": {
		id: "xenova-bge-small-zh-v1.5",
		label: "Chinese only",
		repoId: "Xenova/bge-small-zh-v1.5",
		dim: 512,
		maxTokens: 512,
		pooling: "cls",
	},
};

export const DEFAULT_EMBEDDING_MODEL_ID: EmbeddingModelId = "xenova-all-MiniLM-L6-v2";

export const DEFAULT_SETTINGS: SimilaritySettings = {
	ignoredPaths: [],
	advancedOpen: false,
	maxRawMarkdownChars: 20000,
	maxExtractedChars: 4800,
	maxOverlapPercent: 15,
	embeddingModelId: DEFAULT_EMBEDDING_MODEL_ID,
};

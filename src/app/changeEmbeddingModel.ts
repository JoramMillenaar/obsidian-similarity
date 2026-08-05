import { EmbeddingModelId } from "../types";
import { EmbeddingPort, IndexStorage, SettingsRepository, StatusReporter } from "../ports";
import { EMBEDDING_MODELS } from "../constants";
import { EmbeddingQueue } from "./embeddingQueue";
import { SynchronizeIndexUseCase } from "./synchronizeIndex";

export type ChangeEmbeddingModelUseCase = (modelId: EmbeddingModelId) => Promise<void>;

type ChangeEmbeddingModelDeps = {
	embedder: EmbeddingPort;
	settingsRepo: SettingsRepository;
	indexStorage: IndexStorage;
	queue: EmbeddingQueue;
	synchronizeIndex: SynchronizeIndexUseCase;
	status: StatusReporter;
};

export function makeChangeEmbeddingModel(deps: ChangeEmbeddingModelDeps): ChangeEmbeddingModelUseCase {
	let inFlight: Promise<void> | null = null;

	async function run(modelId: EmbeddingModelId): Promise<void> {
		const settings = await deps.settingsRepo.get();
		if (settings.embeddingModelId === modelId) return;

		const config = EMBEDDING_MODELS[modelId];

		deps.queue.reset();

		deps.embedder.unload();

		await deps.indexStorage.flush();

		await deps.settingsRepo.updatePartial({embeddingModelId: modelId});

		deps.status.update(`Loading ${config.label} model…`);
		await deps.embedder.load(config);

		await deps.indexStorage.repair();

		deps.status.update(`Switched to ${config.label}.`, 4000);

		void rebuild();
	}

	async function rebuild(): Promise<void> {
		try {
			await deps.synchronizeIndex().catch(() => undefined);
			await deps.synchronizeIndex();
		} catch (error) {
			console.error("[Similarity] Reindex after model change failed:", error);
		}
	}

	return async function changeEmbeddingModel(modelId) {
		if (inFlight) throw new Error("An embedding model change is already in progress");

		inFlight = run(modelId).finally(() => {
			inFlight = null;
		});
		return await inFlight;
	};
}

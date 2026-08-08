import { EmbeddingModelId } from "../types";
import { EmbeddingPort, SettingsRepository, StatusReporter } from "../ports";
import { EMBEDDING_MODELS } from "../constants";
import { JobQueue } from "./jobQueue";
import { SynchronizeIndexUseCase } from "./synchronizeIndex";
import { ThrottledIndexStorage } from "../domain/throttledIndexStorage";
import { ModelSession } from "../domain/modelSession";

export type ChangeEmbeddingModelUseCase = (modelId: EmbeddingModelId) => Promise<void>;

type ChangeEmbeddingModelDeps = {
	embedder: EmbeddingPort;
	settingsRepo: SettingsRepository;
	indexStorage: ThrottledIndexStorage;
	queue: JobQueue;
	synchronizeIndex: SynchronizeIndexUseCase;
	status: StatusReporter;
	modelSession: ModelSession;
};

export function makeChangeEmbeddingModel(deps: ChangeEmbeddingModelDeps): ChangeEmbeddingModelUseCase {
	let inFlight: Promise<void> | null = null;

	async function run(modelId: EmbeddingModelId): Promise<void> {
		const previousModelId = deps.modelSession.current();
		if (previousModelId === modelId) return;

		const config = EMBEDDING_MODELS[modelId];

		deps.modelSession.beginSwitch(modelId);

		try {
			deps.queue.reset();

			deps.embedder.unload();

			await deps.indexStorage.flush();

			await deps.settingsRepo.updatePartial({embeddingModelId: modelId});

			deps.status.update(`Loading ${config.label} model…`);
			await deps.embedder.load(config);

			await deps.indexStorage.repair(modelId);

			deps.modelSession.completeSwitch();
		} catch (error) {
			deps.modelSession.abortSwitch();
			await deps.settingsRepo.updatePartial({embeddingModelId: previousModelId}).catch(() => undefined);
			deps.status.update(`Failed to switch to ${config.label}.`, 4000);
			throw error;
		}

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

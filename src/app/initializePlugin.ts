import { AppContainer } from "../appContainer";
import { EMBEDDING_MODELS } from "../constants";

export async function initializePlugin(app: AppContainer): Promise<void> {
	app.status.update("Starting…");

	try {
		await app.runLegacyMigrations();

		const {embeddingModelId} = await app.settingsRepo.get();
		app.modelSession.hydrate(embeddingModelId);
		const config = EMBEDDING_MODELS[embeddingModelId];
		const loadStartedAt = Date.now();
		await app.embedder.load(config, (progress) => {
			if (Date.now() - loadStartedAt < 1000) return;
			app.status.update(`Downloading ${config.label} model… ${Math.round(progress.progress)}%`);
		});

		await app.indexStorage.repair(embeddingModelId);

		app.status.update("Optimizing experience...");
		void app.synchronizeIndex().catch((error) => {
			console.error("[Similarity] Index repair failed", error);
		});

		app.status.update("Done", 1500);
	} catch (error) {
		app.status.update("Failed to start (see console)", 8000);
		console.error("[Similarity] start() failed", error);
	}

	await app.similarityView.activate({reveal: false, focus: false});

	app.similarityView.refreshResults();
}

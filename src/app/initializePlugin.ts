import { AppContainer } from "../appContainer";
import { ModelRequestSupersededError } from "../embedding/engine";

export async function initializePlugin(app: AppContainer): Promise<void> {
	app.status.update("Starting…");

	try {
		await app.runLegacyMigrations();

		const {embeddingModelId} = app.settingsRepo.get();

		// Open the index before loading the model: ranking stored vectors needs no
		// embedder, so results are available while the model is still downloading.
		await app.indexer.useModel(embeddingModelId).catch((error) => {
			console.error("[Similarity] Failed to open the index:", error);
		});

		await app.engine.requestModel(embeddingModelId);

		app.status.update("Done", 1500);
	} catch (error) {
		if (!(error instanceof ModelRequestSupersededError)) {
			app.status.update("Failed to start (see console)", 8000);
			console.error("[Similarity] start() failed", error);
		}
	}

	await app.vault.activateSimilarityView({reveal: false, focus: false});

	app.similarNotesFeed.refresh();
}

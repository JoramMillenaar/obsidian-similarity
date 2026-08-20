import { AppContainer } from "../appContainer";
import { ModelRequestSupersededError } from "./modelSession";

export async function initializePlugin(app: AppContainer): Promise<void> {
	app.status.update("Starting…");

	try {
		await app.runLegacyMigrations();

		const {embeddingModelId} = await app.settingsRepo.get();
		await app.modelSession.requestModel(embeddingModelId);

		app.status.update("Done", 1500);
	} catch (error) {
		if (!(error instanceof ModelRequestSupersededError)) {
			app.status.update("Failed to start (see console)", 8000);
			console.error("[Similarity] start() failed", error);
		}
	}

	await app.activateSimilarityView({reveal: false, focus: false});

	app.similarNotesFeed.refresh();
}

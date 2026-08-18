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
		// Superseded means the user switched models (or the plugin unloaded) before startup finished —
		// that request owns the outcome, so there is nothing to report here.
		if (!(error instanceof ModelRequestSupersededError)) {
			app.status.update("Failed to start (see console)", 8000);
			console.error("[Similarity] start() failed", error);
		}
	}

	await app.similarityView.activate({reveal: false, focus: false});

	app.similarityView.refreshResults();
}

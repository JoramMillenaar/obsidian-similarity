import { AppContainer } from "../appContainer";
import { ModelRequestSupersededError } from "../embedding/engine";
import { EMBEDDING_MODEL } from "../constants";

export async function initializePlugin(app: AppContainer): Promise<void> {
	app.status.update("Starting…");

	try {
		await app.removeDeprecatedData();

		await app.indexer.useModel(EMBEDDING_MODEL.id).catch((error) => {
			console.error("[Similarity] Failed to open the index:", error);
		});

		if (app.deviceSettingsRepo.get().modelDisabled) {
			await app.engine.disable();
		} else {
			await app.engine.requestModel(EMBEDDING_MODEL);
		}

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

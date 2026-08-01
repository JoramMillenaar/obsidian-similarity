import { AppContainer } from "../appContainer";

export async function initializePlugin(app: AppContainer): Promise<void> {
	app.status.update("Starting…");

	try {
		await app.embedder.load();

		await app.indexStorage.repair();

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
}

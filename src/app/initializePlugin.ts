import { Plugin, TFile } from "obsidian";
import { SimilarNotesListView, VIEW_TYPE_SIMILARITY } from "../ui/SimilarNotesListView";
import { AppContainer } from "../appContainer";
import { activateRightLeafView } from "./activateRightLeafView";

export async function initializePlugin(
	plugin: Plugin,
	app: AppContainer,
): Promise<void> {
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

	plugin.registerEvent(
		plugin.app.workspace.on("editor-change", (_editor, info) => {
			const file = info.file;
			if (!(file instanceof TFile)) return;

			app.liveNoteSync.update(file.path);
		}),
	);

	plugin.registerEvent(
		plugin.app.vault.on("delete", (file) => {
			if (!(file instanceof TFile)) return;

			void app.liveNoteSync.delete(file.path);

			app.status.update("Note removed from index", 1500);
		}),
	);

	plugin.registerEvent(
		plugin.app.vault.on("rename", (file, oldPath) => {
			if (!(file instanceof TFile)) return;

			void app.liveNoteSync.rename(oldPath, file.path);

			app.status.update("Index updated (rename)", 1500);
		}),
	);

	plugin.registerEvent(
		plugin.app.workspace.on("file-open", (file) => {
			if (file instanceof TFile) {
				app.liveNoteSync.view(file.path);
			}

			const leaf = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_SIMILARITY).first();
			if (leaf && leaf.view instanceof SimilarNotesListView) {
				void leaf.view.refresh();
			}
		}),
	);

	await activateRightLeafView(plugin, {reveal: false, focus: false});
}

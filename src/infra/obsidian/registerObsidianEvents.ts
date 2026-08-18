import { Plugin, TFile } from "obsidian";
import { AppContainer } from "../../appContainer";
import { LiveNoteSync } from "../../app/liveNoteSync";
import { ModelNotReadyError } from "../../app/modelSession";


export type ObsidianEventsDeps = Pick<AppContainer, "modelSession" | "status" | "similarityView">;

function withLiveNoteSync(
	container: ObsidianEventsDeps,
	failureMessage: string,
	action: (liveNoteSync: LiveNoteSync) => void | Promise<void>,
): void {
	void container.modelSession
		.withGeneration(async (generation) => action(generation.liveNoteSync))
		.catch((error) => {
			if (error instanceof ModelNotReadyError) return;
			console.error(`[Similarity] ${failureMessage}`, error);
		});
}

export function registerObsidianEvents(plugin: Plugin, container: ObsidianEventsDeps): void {
	plugin.registerEvent(
		plugin.app.workspace.on("editor-change", (_editor, info) => {
			const file = info.file;
			if (!(file instanceof TFile)) return;

			withLiveNoteSync(container, "Indexing edited note failed", (liveNoteSync) => {
				liveNoteSync.update(file.path);
			});
		}),
	);

	plugin.registerEvent(
		plugin.app.vault.on("delete", (file) => {
			if (!(file instanceof TFile)) return;

			withLiveNoteSync(container, "Delete from index failed", (liveNoteSync) =>
				liveNoteSync.delete(file.path),
			);

			container.status.update("Note removed from index", 1500);
		}),
	);

	plugin.registerEvent(
		plugin.app.vault.on("rename", (file, oldPath) => {
			if (!(file instanceof TFile)) return;

			withLiveNoteSync(container, "Rename note failed", (liveNoteSync) =>
				liveNoteSync.rename(oldPath, file.path),
			);

			container.status.update("Index updated (rename)", 1500);
		}),
	);

	plugin.registerEvent(
		plugin.app.workspace.on("file-open", (file) => {
			if (file instanceof TFile) {
				withLiveNoteSync(container, "Indexing viewed note failed", (liveNoteSync) => {
					liveNoteSync.view(file.path);
				});
			}

			container.similarityView.refreshResults();
		}),
	);
}

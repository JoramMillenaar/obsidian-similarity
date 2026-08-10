import { Plugin, TFile } from "obsidian";
import { AppContainer } from "../../appContainer";

export function registerObsidianEvents(plugin: Plugin, container: AppContainer): void {
	plugin.registerEvent(
		plugin.app.workspace.on("editor-change", (_editor, info) => {
			const file = info.file;
			if (!(file instanceof TFile)) return;

			container.liveNoteSync.update(file.path);
		}),
	);

	plugin.registerEvent(
		plugin.app.vault.on("delete", (file) => {
			if (!(file instanceof TFile)) return;

			void container.liveNoteSync.delete(file.path);

			container.status.update("Note removed from index", 1500);
		}),
	);

	plugin.registerEvent(
		plugin.app.vault.on("rename", (file, oldPath) => {
			if (!(file instanceof TFile)) return;

			void container.liveNoteSync.rename(oldPath, file.path);

			container.status.update("Index updated (rename)", 1500);
		}),
	);

	plugin.registerEvent(
		plugin.app.workspace.on("file-open", (file) => {
			if (file instanceof TFile) {
				container.liveNoteSync.view(file.path);
			}

			container.similarityView.refreshResults();
		}),
	);
}

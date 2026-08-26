import { Plugin, TFile, TFolder } from "obsidian";
import { StatusReporter } from "../ports";
import { EmbeddingEngine } from "../embedding/engine";
import { Indexer } from "./indexer";

export type VaultEventDeps = {
	indexer: Indexer;
	engine: EmbeddingEngine;
	status: StatusReporter;
	onActiveNoteChanged: () => void;
};

export function registerVaultEvents(plugin: Plugin, deps: VaultEventDeps): void {
	plugin.registerDomEvent(window, "online", () => {
		if (deps.engine.status().kind !== "error") return;

		deps.status.update("Back online — loading the model…");
		void deps.engine.retry().catch((error) => {
			console.error("[Similarity] Retrying the model load after reconnecting failed:", error);
		});
	});

	plugin.registerEvent(
		plugin.app.workspace.on("editor-change", (_editor, info) => {
			const file = info.file;
			if (!(file instanceof TFile)) return;
			deps.indexer.edited(file.path);
		}),
	);

	plugin.registerEvent(
		plugin.app.vault.on("delete", (file) => {
			if (file instanceof TFile) {
				deps.indexer.remove(file.path);
				deps.status.update("Note removed from index", 1500);
			} else if (file instanceof TFolder) {
				deps.indexer.removeFolder(file.path);
				deps.status.update("Folder removed from index", 1500);
			}
		}),
	);

	plugin.registerEvent(
		plugin.app.vault.on("rename", (file, oldPath) => {
			if (file instanceof TFile) {
				deps.indexer.rename(oldPath, file.path);
			} else if (file instanceof TFolder) {
				deps.indexer.renameFolder(oldPath, file.path);
			} else {
				return;
			}

			deps.status.update("Index updated (rename)", 1500);
		}),
	);

	plugin.registerEvent(
		plugin.app.workspace.on("file-open", (file) => {
			if (file instanceof TFile) deps.indexer.view(file.path);
			deps.onActiveNoteChanged();
		}),
	);
}

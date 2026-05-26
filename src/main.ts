import { Notice, Plugin } from "obsidian";
import { SearchModal } from "./ui/SearchModal";
import { initializePlugin } from "./app/initializePlugin";
import { AppContainer } from "./appContainer";
import { SimilarNotesListView, VIEW_TYPE_SIMILARITY } from "./ui/SimilarNotesListView";
import { activateRightLeafView } from "./app/activateRightLeafView";
import { SettingView } from "./ui/SettingsView";
import { isMarkdownPath } from "./domain/markdownPath";

export default class RelatedNotes extends Plugin {
	private appContainer!: AppContainer;

	onload(): void {
		this.appContainer = new AppContainer(this);
		this.appContainer.status.update("Loading…");

		this.addSettingTab(new SettingView(this.app, this, {
			settingsRepo: this.appContainer.settingsRepo,
			updateSettings: this.appContainer.updateSettings
		}));

		this.registerView(
			VIEW_TYPE_SIMILARITY,
			(leaf) =>
				new SimilarNotesListView(leaf, {
					indexRepo: this.appContainer.indexRepo,
					getSimilarNotes: this.appContainer.getSimilarNotes,
					startOrRefreshIndexSync: this.appContainer.startOrRefreshIndexSync,
					subscribeIndexingState: this.appContainer.subscribeIndexingState,
					isIgnoredPath: this.appContainer.isIgnoredPath,
				})
		);
		this.registerHoverLinkSource(VIEW_TYPE_SIMILARITY, {
			display: "Similarity",
			defaultMod: true,
		});

		this.addCommand({
			id: "sync-vault",
			name: "Sync vault index",
			callback: async () => {
				this.appContainer.status.update("Syncing vault index…");
				try {
					await this.appContainer.syncIndexToVault({
						onProgress: (p) => {
							this.appContainer.status.update(`${p.processed}/${p.total} indexed`);
						},
					});
					this.refreshView();
					this.appContainer.status.update("Index synced", 2500);
					new Notice("Similarity index synced");
				} catch (error) {
					this.appContainer.status.update("Sync failed (see console)", 5000);
					console.error("[Similarity] Sync failed", error);
					new Notice("Similarity sync failed");
				}
			},
		});

		this.addCommand({
			id: "reindex-current",
			name: "Refresh current note",
			callback: async () => {
				const f = this.app.workspace.getActiveFile();
				if (!f) return;
				if (!isMarkdownPath(f.path)) {
					this.appContainer.status.update("Only Markdown notes are indexed", 3000);
					this.refreshView();
					return;
				}

				this.appContainer.status.update("Indexing current note…");
				try {
					await this.appContainer.bumpIndexPriority(f.path, "manual");
					await this.appContainer.awaitIndexedNote(f.path);
					this.refreshView();
					this.appContainer.status.update("Current note refreshed", 2000);
				} catch (error) {
					this.appContainer.status.update("Index failed (see console)", 5000);
					console.error("[Similarity] Reindex current failed", error);
				}
			},
		});

		this.addCommand({
			id: "open-search-modal",
			name: "Open semantic search",
			callback: () => {
				new SearchModal(this.app, {
					getSimilarNotes: this.appContainer.getSimilarNotes,
					insertWikilinkAtCursor: this.appContainer.insertWikilinkAtCursor,
					subscribeIndexingState: this.appContainer.subscribeIndexingState,
					indexRepo: this.appContainer.indexRepo,
					isIgnoredPath: this.appContainer.isIgnoredPath,
				}).open();
			},
		});

		this.addCommand({
			id: "open-similar-notes",
			name: "Open similar notes",
			callback: async () => {
				await activateRightLeafView(this, {reveal: true, focus: true});
			},
		});

		this.app.workspace.onLayoutReady(() => {
			void initializePlugin(this, this.appContainer);
		});
	}

	onunload(): void {
		this.appContainer.shutdown();
	}

	private refreshView(): void {
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_SIMILARITY).first();
		if (leaf && leaf.view instanceof SimilarNotesListView) {
			void leaf.view.refresh();
		}
	}
}

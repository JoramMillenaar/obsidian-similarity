import { Plugin } from "obsidian";
import { SearchModal } from "./ui/SearchModal";
import { initializePlugin } from "./app/initializePlugin";
import { AppContainer } from "./appContainer";
import { SimilarNotesListView, VIEW_TYPE_SIMILARITY } from "./ui/SimilarNotesListView";
import { SettingView } from "./ui/SettingsView";
import { registerObsidianEvents } from "./infra/obsidian/registerObsidianEvents";

export default class SimilarNotes extends Plugin {
	private appContainer!: AppContainer;

	onload(): void {
		this.appContainer = new AppContainer(this);
		this.appContainer.status.update("Loading…");

		this.addSettingTab(new SettingView(this.app, this, {
			settingsRepo: this.appContainer.settingsRepo,
			updateSettings: this.appContainer.updateSettings,
			modelSession: this.appContainer.modelSession,
		}));

		this.registerView(
			VIEW_TYPE_SIMILARITY,
			(leaf) =>
				new SimilarNotesListView(leaf, {
					similarNotesFeed: this.appContainer.similarNotesFeed,
					backendState: this.appContainer.backendState,
				})
		);
		this.registerHoverLinkSource(VIEW_TYPE_SIMILARITY, {
			display: "Similarity",
			defaultMod: true,
		});

		this.addCommand({
			id: "open-search-modal",
			name: "Open semantic search",
			callback: () => {
				new SearchModal(this.app, {
					similarSearchFeed: this.appContainer.similarSearchFeed,
					backendState: this.appContainer.backendState,
					insertWikilinkAtCursor: this.appContainer.insertWikilinkAtCursor,
				}).open();
			},
		});

		this.addCommand({
			id: "open-similar-notes",
			name: "Open similar notes",
			callback: async () => {
				await this.appContainer.similarityView.activate({reveal: true, focus: true});
			},
		});

		this.app.workspace.onLayoutReady(() => {
			registerObsidianEvents(this, this.appContainer);
			void initializePlugin(this.appContainer);
			this.appContainer.similarityView.refreshResults();
		});

		// if (__DEV__) {
		// 	registerDevCommands(this, this.appContainer);
		// }
	}

	onunload(): void {
		void this.appContainer.shutdown();
	}
}

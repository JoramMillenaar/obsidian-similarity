import { Plugin } from "obsidian";
import { SearchModal } from "./ui/SearchModal";
import { initializePlugin } from "./app/initializePlugin";
import { AppContainer } from "./appContainer";
import { SimilarNotesListView, VIEW_TYPE_SIMILARITY } from "./ui/SimilarNotesListView";
import { SettingView } from "./ui/SettingsView";
import { registerVaultEvents } from "./indexing/vaultEvents";
import { FeedbackModal, FeedbackRequest } from "./ui/FeedbackModal";

export default class SimilarNotes extends Plugin {
	private appContainer!: AppContainer;

	async onload(): Promise<void> {
		this.appContainer = new AppContainer(this);
		this.appContainer.status.update("Loading…");

		await this.appContainer.pluginDataStore.load();

		const openFeedback = (request: FeedbackRequest) => {
			new FeedbackModal(this.app, request, {
				collectEnvironment: () => this.appContainer.collectEnvironment(),
			}).open();
		};

		this.addSettingTab(new SettingView(this.app, this, {
			settingsRepo: this.appContainer.settingsRepo,
			updateSettings: this.appContainer.updateSettings,
			setSearchMode: this.appContainer.setSearchMode,
			setModelDisabled: this.appContainer.setModelDisabled,
			engine: this.appContainer.engine,
			openFeedback,
		}));

		const openSearchModal = () => {
			new SearchModal(this.app, {
				similarSearchFeed: this.appContainer.similarSearchFeed,
				statusHub: this.appContainer.statusHub,
				insertWikilinkAtCursor: this.appContainer.insertWikilinkAtCursor,
			}).open();
		};

		const openSettings = () => {
			this.app.setting.open();
			this.app.setting.openTabById("similarity");
		};

		this.registerView(
			VIEW_TYPE_SIMILARITY,
			(leaf) =>
				new SimilarNotesListView(leaf, {
					similarNotesFeed: this.appContainer.similarNotesFeed,
					statusHub: this.appContainer.statusHub,
					getNoteText: this.appContainer.getNoteText,
					settingsRepo: this.appContainer.settingsRepo,
					setSearchMode: this.appContainer.setSearchMode,
					openSearchModal,
					openSettings,
					openFeedback,
				})
		);
		this.registerHoverLinkSource(VIEW_TYPE_SIMILARITY, {
			display: "Similarity",
			defaultMod: true,
		});

		this.addCommand({
			id: "open-search-modal",
			name: "Open semantic search",
			callback: openSearchModal,
		});

		this.addCommand({
			id: "open-similar-notes",
			name: "Open similar notes",
			callback: async () => {
				await this.appContainer.vault.activateSimilarityView({reveal: true, focus: true});
			},
		});

		this.app.workspace.onLayoutReady(() => {
			registerVaultEvents(this, {
				indexer: this.appContainer.indexer,
				engine: this.appContainer.engine,
				status: this.appContainer.status,
				onActiveNoteChanged: () => this.appContainer.similarNotesFeed.refresh(),
			});
			void initializePlugin(this.appContainer);
			this.appContainer.similarNotesFeed.refresh();
		});

		// if (__DEV__) {
		// 	registerDevCommands(this, this.appContainer);
		// }
	}

	onunload(): void {
		void this.appContainer.shutdown();
	}
}

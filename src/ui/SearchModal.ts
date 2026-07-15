import { App, Notice, Platform, SuggestModal, TFile } from "obsidian";
import { GetSimilarNotesUseCase } from "../app/getSimilarNotes";
import { InsertWikilinkAtCursorUseCase } from "../app/insertWikilinkAtCursor";
import { SubscribeIndexingStateUseCase } from "../app/indexingCoordinator";
import { KeyedDebouncer } from "../domain/debouncer";
import { isMarkdownPath } from "../domain/markdownPath";
import { IndexingQueueSnapshot, RelatedNote } from "../types";
import { IndexRepository } from "../ports";

export type SearchModalDeps = {
	getSimilarNotes: GetSimilarNotesUseCase;
	insertWikilinkAtCursor: InsertWikilinkAtCursorUseCase;
	indexRepo: IndexRepository;
	isIgnoredPath: (path: string) => Promise<boolean>;
	subscribeIndexingState: SubscribeIndexingStateUseCase;
}

export class SearchModal extends SuggestModal<RelatedNote> {
	private static readonly MIN_ITEMS_FOR_PROGRESS_BANNER = 8;
	private readonly deps: SearchModalDeps;
	private readonly debouncer: KeyedDebouncer<string>;
	private chooseMode: "open" | "open-new-tab" | "open-right" | "insert-link" = "open";
	private isAutoRefreshing = false;
	private indexingState: IndexingQueueSnapshot = {
		isRunning: false,
		phase: "indexing",
		hasCompletedInitialIndex: false,
		pending: 0,
		processed: 0,
		total: 0,
		failed: 0,
		banner: {
			kind: "hidden",
			message: "",
			processed: 0,
			total: 0,
		},
	};
	private lastAutoRefreshAt = 0;
	private unsubscribeIndexingState?: () => void;
	private refreshTimer?: number;
	private bannerEl?: HTMLElement;

	private static readonly DEFAULT_EMPTY_STATE = "Type to search related notes.";
	private static readonly LOADING_EMPTY_STATE = "Searching related notes...";
	private static readonly NO_RESULTS_EMPTY_STATE = "No related notes found.";
	private static readonly NO_RESULTS_DURING_INDEX_STATE = "No related notes found yet. More may appear while indexing continues.";
	private static readonly EMPTY_DURING_INDEX_STATE = "Indexing is still in progress. Results will appear as notes are processed.";
	private static readonly EMPTY_INDEX_STATE = "Your index is empty. Run “Sync vault index” to rebuild it.";
	private static readonly IGNORED_NOTE_STATE = "The current note is ignored by settings.";
	private static readonly NON_MARKDOWN_NOTE_STATE = this.DEFAULT_EMPTY_STATE;
	private static readonly NO_ACTIVE_NOTE_STATE = "Open a note to see similar notes.";

	constructor(app: App, deps: SearchModalDeps) {
		super(app);
		this.deps = deps;
		this.debouncer = new KeyedDebouncer(300);
		this.emptyStateText = SearchModal.DEFAULT_EMPTY_STATE;
		this.setInstructions([
			{command: "↑↓", purpose: "navigate"},
			{command: "↵", purpose: "select"},
			{command: Platform.isMacOS ? "⌘ ↵" : "Ctrl ↵", purpose: "open in new tab"},
			{command: Platform.isMacOS ? "⌘ ⌥ ↵" : "Ctrl Alt ↵", purpose: "open to the right"},
			{command: Platform.isMacOS ? "⌘ ⇧ ↵" : "Ctrl Shift ↵", purpose: "insert wikilink"},
			{command: "esc", purpose: "close"},
		]);
		this.scope.register(["Mod"], "Enter", (evt) => {
			this.chooseMode = "open-new-tab";
			this.selectActiveSuggestion(evt);
			return false;
		});
		this.scope.register(["Mod", "Alt"], "Enter", (evt) => {
			this.chooseMode = "open-right";
			this.selectActiveSuggestion(evt);
			return false;
		});
		this.scope.register(["Mod", "Shift"], "Enter", (evt) => {
			this.chooseMode = "insert-link";
			this.selectActiveSuggestion(evt);
			return false;
		});
	}

	onOpen(): void {
		void super.onOpen();
		this.ensureBanner();
		this.unsubscribeIndexingState = this.deps.subscribeIndexingState((snapshot) => {
			const previous = this.indexingState;
			this.indexingState = snapshot;
			this.renderBanner();

			if (this.shouldRefreshSuggestions(previous, snapshot)) {
				this.scheduleSuggestionRefresh();
			}
		});
		window.setTimeout(() => this.inputEl.dispatchEvent(new Event("input")), 0);
	}

	onClose(): void {
		if (this.refreshTimer) {
			window.clearTimeout(this.refreshTimer);
			this.refreshTimer = undefined;
		}
		this.unsubscribeIndexingState?.();
		super.onClose();
	}

	async getSuggestions(query: string): Promise<RelatedNote[]> {
		const isAutoRefresh = this.isAutoRefreshing;
		this.isAutoRefreshing = false;

		if (!query) {
			return this.getInitialSuggestions(isAutoRefresh);
		}

		if (!isAutoRefresh) {
			this.emptyStateText = SearchModal.LOADING_EMPTY_STATE;
			this.onNoSuggestion();
		}

		return new Promise((resolve) => {
			this.debouncer.schedule("search", async () => {
				try {
					const indexEmpty = await this.deps.indexRepo.isEmpty();
					if (indexEmpty) {
						this.emptyStateText = this.indexingState.banner.kind !== "hidden"
							? SearchModal.EMPTY_DURING_INDEX_STATE
							: SearchModal.EMPTY_INDEX_STATE;
						resolve([]);
						return;
					}

					const results = await this.deps.getSimilarNotes({text: query});
					this.emptyStateText = results.length > 0
						? SearchModal.DEFAULT_EMPTY_STATE
						: this.getNoResultsText();
					resolve(results);
				} catch (e) {
					console.error("[Related Notes Search] Failed to get related notes:", e);
					this.emptyStateText = this.getNoResultsText();
					resolve([]);
				}
			});
		});
	}

	onChooseSuggestion(item: RelatedNote, evt: MouseEvent | KeyboardEvent): void {
		const chooseMode = this.chooseMode;
		this.chooseMode = "open";

		if (chooseMode === "insert-link" && evt instanceof KeyboardEvent) {
			this.handleInsertLink(item);
			return;
		}

		const file = this.app.vault.getAbstractFileByPath(item.id);
		if (file instanceof TFile) {
			if (chooseMode === "open-new-tab") {
				void this.app.workspace.getLeaf(true).openFile(file);
				return;
			}
			if (chooseMode === "open-right") {
				void this.app.workspace.getLeaf("split", "vertical").openFile(file);
				return;
			}
			void this.app.workspace.getLeaf(false).openFile(file);
		}
	}

	private handleInsertLink(item: RelatedNote): void {
		const result = this.deps.insertWikilinkAtCursor(item.id);
		if (result === "inserted") {
			this.close();
			return;
		}

		new Notice("Could not insert link: no active editor.");
	}

	renderSuggestion(value: RelatedNote, el: HTMLElement): void {
		let fileName = value.id;
		if (fileName.endsWith(".md")) fileName = fileName.slice(0, -3);
		const scorePercent = (value.score * 100).toFixed(0);

		const titleEl = el.createDiv({text: fileName});
		titleEl.addClass("internal-link");

		if (value.centroid) {
			el.createEl("small", {text: value.centroid, cls: "suggestion-description"});
		}

		el.createEl("small", {text: `${scorePercent}%`, cls: "suggestion-note"});
	}

	private async getInitialSuggestions(isAutoRefresh = false): Promise<RelatedNote[]> {
		const active = this.app.workspace.getActiveFile();
		if (!active) {
			this.emptyStateText = SearchModal.NO_ACTIVE_NOTE_STATE;
			return [];
		}
		if (!isMarkdownPath(active.path)) {
			this.emptyStateText = SearchModal.NON_MARKDOWN_NOTE_STATE;
			return [];
		}

		if (!isAutoRefresh) {
			this.emptyStateText = SearchModal.LOADING_EMPTY_STATE;
			this.onNoSuggestion();
		}

		try {
			const [indexEmpty, isIgnored] = await Promise.all([
				this.deps.indexRepo.isEmpty(),
				this.deps.isIgnoredPath(active.path),
			]);

			if (isIgnored) {
				this.emptyStateText = SearchModal.IGNORED_NOTE_STATE;
				return [];
			}

			if (indexEmpty) {
				this.emptyStateText = this.indexingState.banner.kind !== "hidden"
					? SearchModal.EMPTY_DURING_INDEX_STATE
					: SearchModal.EMPTY_INDEX_STATE;
				return [];
			}

			const results = await this.deps.getSimilarNotes({noteId: active.path});
			this.emptyStateText = results.length > 0
				? SearchModal.DEFAULT_EMPTY_STATE
				: this.getNoResultsText();
			return results;
		} catch (e) {
			console.error("[Related Notes Search] Failed to get initial suggestions:", e);
			this.emptyStateText = this.getNoResultsText();
			return [];
		}
	}

	private getNoResultsText(): string {
		return this.indexingState.banner.kind !== "hidden"
			? SearchModal.NO_RESULTS_DURING_INDEX_STATE
			: SearchModal.NO_RESULTS_EMPTY_STATE;
	}

	private ensureBanner() {
		if (this.bannerEl) {
			return;
		}

		this.bannerEl = this.resultContainerEl.parentElement?.insertBefore(
			createBannerElement(),
			this.resultContainerEl,
		) ?? undefined;
		this.renderBanner();
	}

	private renderBanner() {
		if (!this.bannerEl) {
			return;
		}

		const banner = this.indexingState.banner;
		this.bannerEl.empty();
		this.bannerEl.className = `similarity-index-banner similarity-index-banner-${banner.kind}`;
		this.bannerEl.toggleClass("is-hidden", !this.shouldShowIndexingBanner());

		if (!this.shouldShowIndexingBanner()) {
			return;
		}

		this.bannerEl.createDiv({
			cls: "similarity-index-banner-message",
			text: banner.message,
		});

		if (banner.total > 0) {
			const progressRow = this.bannerEl.createDiv({cls: "similarity-index-banner-progress"});
			progressRow.createEl("progress", {
				cls: "similarity-index-banner-bar",
				attr: {
					max: String(banner.total),
					value: String(Math.min(banner.processed, banner.total)),
				},
			});
			progressRow.createSpan({
				cls: "similarity-index-banner-label",
				text: banner.progressLabel ?? "",
			});
		}
	}

	private scheduleSuggestionRefresh() {
		if (this.refreshTimer) {
			return;
		}

		const elapsed = Date.now() - this.lastAutoRefreshAt;
		const delay = Math.max(0, 1500 - elapsed);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = undefined;
			this.lastAutoRefreshAt = Date.now();
			this.isAutoRefreshing = true;
			this.inputEl.dispatchEvent(new Event("input"));
		}, delay);
	}

	private shouldRefreshSuggestions(previous: IndexingQueueSnapshot, snapshot: IndexingQueueSnapshot): boolean {
		if (previous.banner.kind !== snapshot.banner.kind || previous.fatalError !== snapshot.fatalError) {
			return true;
		}
		if (previous.isRunning && !snapshot.isRunning) {
			return true;
		}

		const activePath = this.app.workspace.getActiveFile()?.path;
		if (activePath && previous.currentNoteId === activePath && snapshot.currentNoteId !== activePath) {
			return true;
		}

		if (previous.processed !== snapshot.processed) {
			return Date.now() - this.lastAutoRefreshAt >= 1500;
		}

		return false;
	}

	private shouldShowIndexingBanner(): boolean {
		const {banner, total} = this.indexingState;
		if (banner.kind === "hidden" || banner.kind === "failed") {
			return banner.kind === "failed";
		}

		return total > SearchModal.MIN_ITEMS_FOR_PROGRESS_BANNER - 1;
	}
}

function createBannerElement() {
	const element = createDiv();
	element.className = "similarity-index-banner similarity-index-banner-hidden is-hidden";
	return element;
}

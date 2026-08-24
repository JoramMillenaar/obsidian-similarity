import { App, Notice, Platform, SuggestModal, TFile } from "obsidian";
import { InsertWikilinkAtCursorUseCase } from "../app/insertWikilinkAtCursor";
import { SimilarSearchFeed, SimilarSearchResult } from "../search/similarSearchFeed";
import { StatusHub } from "../status/statusHub";
import { BannerState, computeBanner, subscribeBanner } from "./banner";
import { textForNotice } from "./similarNoticeText";
import { KeyedDebouncer } from "../core/util/debounce";
import { RelatedNote } from "../types";

export type SearchModalDeps = {
	similarSearchFeed: SimilarSearchFeed;
	statusHub: StatusHub;
	insertWikilinkAtCursor: InsertWikilinkAtCursorUseCase;
}

export class SearchModal extends SuggestModal<RelatedNote> {
	private readonly deps: SearchModalDeps;
	private readonly debouncer: KeyedDebouncer<string>;
	private chooseMode: "open" | "open-new-tab" | "open-right" | "insert-link" = "open";
	private isAutoRefreshing = false;
	private unsubscribeBanner?: () => void;
	private unsubscribeRefreshSignal?: () => void;
	private bannerEl?: HTMLElement;

	private static readonly DEFAULT_EMPTY_STATE = "Type to search related notes.";
	private static readonly LOADING_EMPTY_STATE = "Searching similar notes...";
	private static readonly NO_RESULTS_EMPTY_STATE = "No similar notes found.";
	private static readonly NO_RESULTS_DURING_INDEX_STATE = "No similar notes found yet. More may appear while processing continues.";
	private static readonly NON_MARKDOWN_NOTE_STATE = this.DEFAULT_EMPTY_STATE;

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
		this.unsubscribeBanner = subscribeBanner(this.deps.statusHub, (banner) => this.renderBanner(banner));
		this.unsubscribeRefreshSignal = this.deps.similarSearchFeed.subscribeRefreshSignal(() => {
			this.isAutoRefreshing = true;
			this.inputEl.dispatchEvent(new Event("input"));
		});
		window.setTimeout(() => this.inputEl.dispatchEvent(new Event("input")), 0);
	}

	onClose(): void {
		this.unsubscribeBanner?.();
		this.unsubscribeRefreshSignal?.();
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
					const result = await this.deps.similarSearchFeed.resolveForQuery(query);
					this.emptyStateText = this.textFor(result);
					resolve(result.items);
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

		el.createEl("small", {text: `${scorePercent}%`, cls: "suggestion-note"});
	}

	private async getInitialSuggestions(isAutoRefresh = false): Promise<RelatedNote[]> {
		if (!isAutoRefresh) {
			this.emptyStateText = SearchModal.LOADING_EMPTY_STATE;
			this.onNoSuggestion();
		}

		try {
			const active = this.app.workspace.getActiveFile();
			const result = await this.deps.similarSearchFeed.resolveForNote(active?.path ?? null);
			this.emptyStateText = this.textFor(result);
			return result.items;
		} catch (e) {
			console.error("[Related Notes Search] Failed to get initial suggestions:", e);
			this.emptyStateText = this.getNoResultsText();
			return [];
		}
	}

	private textFor(result: SimilarSearchResult): string {
		const notice = result.notice;
		if (!notice) {
			return result.items.length > 0 ? SearchModal.DEFAULT_EMPTY_STATE : this.getNoResultsText();
		}

		switch (notice.kind) {
			case "unsupported-file":
				return SearchModal.NON_MARKDOWN_NOTE_STATE;
			case "fatal-error":
				return notice.indexEmpty
					? textForNotice(notice)
					: (result.items.length > 0 ? SearchModal.DEFAULT_EMPTY_STATE : textForNotice(notice));
			case "indexing":
				if (notice.indexEmpty) return textForNotice(notice);
				return result.items.length > 0 ? SearchModal.DEFAULT_EMPTY_STATE : textForNotice(notice);
			default:
				return textForNotice(notice);
		}
	}

	private getNoResultsText(): string {
		return this.isIndexingBusy()
			? SearchModal.NO_RESULTS_DURING_INDEX_STATE
			: SearchModal.NO_RESULTS_EMPTY_STATE;
	}

	private isIndexingBusy(): boolean {
		const indexingState = this.deps.statusHub.getIndexingState();
		if (!indexingState) return false;
		return computeBanner(this.deps.statusHub.getEngineState(), indexingState).visible;
	}

	private renderBanner(banner: BannerState) {
		if (!this.bannerEl) {
			this.bannerEl = this.resultContainerEl.parentElement?.insertBefore(
				createBannerElement(),
				this.resultContainerEl,
			) ?? undefined;
		}
		if (!this.bannerEl) {
			return;
		}

		this.bannerEl.empty();
		this.bannerEl.toggleClass("is-hidden", !banner.visible);

		if (!banner.visible) {
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
		}
	}

}

function createBannerElement() {
	const element = createDiv();
	element.className = "similarity-index-banner is-hidden";
	return element;
}

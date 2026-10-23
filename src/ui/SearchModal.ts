import { App, Notice, Platform, SuggestModal, TFile } from "obsidian";
import { InsertWikilinkAtCursorUseCase } from "../app/insertWikilinkAtCursor";
import { SimilarSearchFeed, SimilarSearchResult } from "../search/similarSearchFeed";
import { StatusHub } from "../status/statusHub";
import { computeBanner } from "./banner";
import { mountBanner } from "./bannerView";
import { textForNotice } from "./similarNoticeText";
import { KeyedDebouncer } from "../core/util/debounce";
import { RelatedNote } from "../types";
import { renderMatchIcon, renderSimilarityBar } from "./similarityBar";
import { noteAgeText } from "./noteAge";
import { groupByTier } from "./tierSections";
import { SIMILARITY_TIER_LABELS } from "../core/vector/similarityTier";
import { GetMatchedPassageUseCase } from "../search/getMatchedPassage";
import { OriginHighlighter } from "./originHighlight";

export type SearchModalDeps = {
	similarSearchFeed: SimilarSearchFeed;
	statusHub: StatusHub;
	insertWikilinkAtCursor: InsertWikilinkAtCursorUseCase;
	getMatchedPassage: GetMatchedPassageUseCase;
}

export class SearchModal extends SuggestModal<RelatedNote> {
	private readonly deps: SearchModalDeps;
	private readonly debouncer: KeyedDebouncer<string>;
	private chooseMode: "open" | "open-new-tab" | "open-right" | "insert-link" = "open";
	private isAutoRefreshing = false;
	private unsubscribeBanner?: () => void;
	private unsubscribeRefreshSignal?: () => void;
	/** Section headings, keyed by the id of the first result under each. */
	private sectionHeadings = new Map<string, string>();
	/** The note the shown results were found for, whose matched passages get highlighted; null for a typed search. */
	private queryNoteId: string | null = null;
	private readonly originHighlighter: OriginHighlighter;
	private readonly suggestionNotes = new WeakMap<HTMLElement, RelatedNote>();
	private selectionObserver?: MutationObserver;
	private selectedNote: RelatedNote | null = null;
	private highlightTimer: number | null = null;

	private static readonly DEFAULT_EMPTY_STATE = "Type to search related notes.";
	private static readonly LOADING_EMPTY_STATE = "Searching similar notes...";
	private static readonly NO_RESULTS_EMPTY_STATE = "No similar notes found.";
	private static readonly NO_RESULTS_DURING_INDEX_STATE = "No similar notes found yet. More may appear while processing continues.";
	private static readonly NON_MARKDOWN_NOTE_STATE = this.DEFAULT_EMPTY_STATE;
	private static readonly KEYWORD_SECTION = "Contains your search words";

	constructor(app: App, deps: SearchModalDeps) {
		super(app);
		this.deps = deps;
		this.originHighlighter = new OriginHighlighter(app);
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
		const resultsParent = this.resultContainerEl.parentElement;
		if (resultsParent) {
			this.unsubscribeBanner = mountBanner(resultsParent, this.deps.statusHub, {before: this.resultContainerEl});
		}
		this.unsubscribeRefreshSignal = this.deps.similarSearchFeed.subscribeRefreshSignal(() => {
			this.isAutoRefreshing = true;
			this.inputEl.dispatchEvent(new Event("input"));
		});
		window.setTimeout(() => this.inputEl.dispatchEvent(new Event("input")), 0);
		this.deps.similarSearchFeed.prepareForQueries();

		// The modal has no selection-change hook, so the selected row is followed through its class.
		this.selectionObserver = new MutationObserver(() => this.followSelection());
		this.selectionObserver.observe(this.resultContainerEl, {subtree: true, childList: true, attributes: true, attributeFilter: ["class"]});
	}

	/** Highlights, in the open note, the passage the selected result matched on (only for results found for that note). */
	private followSelection(): void {
		const selected = this.resultContainerEl.querySelector<HTMLElement>(".suggestion-item.is-selected");
		const note = (selected && this.suggestionNotes.get(selected)) ?? null;
		if (note === this.selectedNote) return;
		this.selectedNote = note;

		if (this.highlightTimer !== null) window.clearTimeout(this.highlightTimer);
		this.highlightTimer = null;
		this.originHighlighter.clear();

		const queryNoteId = this.queryNoteId;
		const queryPassage = note?.queryPassage;
		if (queryNoteId === null || !queryPassage) return;
		this.highlightTimer = window.setTimeout(() => {
			this.highlightTimer = null;
			this.originHighlighter.show(queryNoteId, this.deps.getMatchedPassage(queryNoteId, queryPassage));
		}, 150);
	}

	onClose(): void {
		this.selectionObserver?.disconnect();
		if (this.highlightTimer !== null) window.clearTimeout(this.highlightTimer);
		this.originHighlighter.clear();
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
					this.queryNoteId = null;
					this.emptyStateText = this.textFor(result);
					resolve(this.sortIntoTiers(result.items));
				} catch (e) {
					console.error("[Similarity] Failed to get related notes:", e);
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

	/** Keyword matches first, in their own section; the rest grouped by tier. */
	private sortIntoTiers(items: RelatedNote[]): RelatedNote[] {
		this.sectionHeadings.clear();
		const keyword = items.filter((item) => item.keyword);
		const sorted: RelatedNote[] = [...keyword];
		if (keyword.length) this.sectionHeadings.set(keyword[0].id, SearchModal.KEYWORD_SECTION);
		for (const section of groupByTier(items.filter((item) => !item.keyword))) {
			this.sectionHeadings.set(section.items[0].id, SIMILARITY_TIER_LABELS[section.tier]);
			sorted.push(...section.items);
		}
		return sorted;
	}

	renderSuggestion(value: RelatedNote, el: HTMLElement): void {
		const headingText = this.sectionHeadings.get(value.id);
		if (headingText !== undefined) {
			const heading = createDiv({cls: "suggestion-item mod-group similarity-suggestion-group", text: headingText});
			el.before(heading);
		}
		let fileName = value.id;
		if (fileName.endsWith(".md")) fileName = fileName.slice(0, -3);
		el.addClass("similarity-suggestion");
		this.suggestionNotes.set(el, value);
		renderMatchIcon(el, value, "similarity-suggestion-icon");
		const titleEl = el.createDiv({text: fileName, cls: "similarity-suggestion-title"});
		titleEl.addClass("internal-link");

		const age = noteAgeText(this.app, value.id);
		if (age) el.createEl("small", {text: age, cls: "similarity-suggestion-age"});

		renderSimilarityBar(el, value);
	}

	private async getInitialSuggestions(isAutoRefresh = false): Promise<RelatedNote[]> {
		if (!isAutoRefresh) {
			this.emptyStateText = SearchModal.LOADING_EMPTY_STATE;
			this.onNoSuggestion();
		}

		try {
			const active = this.app.workspace.getActiveFile();
			const result = await this.deps.similarSearchFeed.resolveForNote(active?.path ?? null);
			this.queryNoteId = active?.path ?? null;
			this.emptyStateText = this.textFor(result);
			return this.sortIntoTiers(result.items);
		} catch (e) {
			console.error("[Similarity] Failed to get initial suggestions:", e);
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
		const banner = computeBanner(this.deps.statusHub.getEngineState(), indexingState);
		return banner.visible && banner.tone === "info";
	}
}

import { ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { GetSimilarNotesUseCase } from "../app/getSimilarNotes";
import { StartOrRefreshIndexSyncUseCase, SubscribeIndexingStateUseCase, } from "../app/indexingCoordinator";
import { isMarkdownPath } from "../domain/markdownPath";
import { IndexingQueueSnapshot } from "../types";
import { IndexRepository } from "../ports";

export function logError(message: unknown, ...optionalParams: unknown[]) {
	console.error("[Similarity]:", message, ...optionalParams);
}

export const VIEW_TYPE_SIMILARITY = "similarity";

type SimilarNote = { id: string; score: number };

export type SimilarNotesListViewDeps = {
	indexRepo: IndexRepository;
	getSimilarNotes: GetSimilarNotesUseCase;
	startOrRefreshIndexSync: StartOrRefreshIndexSyncUseCase;
	subscribeIndexingState: SubscribeIndexingStateUseCase;
	isIgnoredPath: (path: string) => Promise<boolean>;
}

export class SimilarNotesListView extends ItemView {
	private static readonly MIN_ITEMS_FOR_PROGRESS_BANNER = 8;
	private isLoading = false;
	private lastAutoRefreshAt = 0;
	private indexingState: IndexingQueueSnapshot = {
		isRunning: false,
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
	private unsubscribeIndexingState?: () => void;
	private refreshTimer?: number;

	constructor(leaf: WorkspaceLeaf, private deps: SimilarNotesListViewDeps) {
		super(leaf);
	}

	getViewType() {
		return VIEW_TYPE_SIMILARITY;
	}

	getDisplayText() {
		return "Similar notes";
	}

	getIcon(): string {
		return "telescope";
	}

	private openNote = (path: string) => {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			new Notice("Error: note not found or invalid file type.");
			return;
		}

		void this.app.workspace
			.getLeaf(false)
			.openFile(file)
			.catch((error) => {
				logError("Error opening note:", error);
				new Notice("Failed to open note.");
			});
	};

	private triggerHoverPreview(event: MouseEvent, targetEl: HTMLElement, path: string) {
		const activeFile = this.app.workspace.getActiveFile();

		this.app.workspace.trigger("hover-link", {
			event,
			source: VIEW_TYPE_SIMILARITY,
			hoverParent: this.containerEl,
			targetEl,
			linktext: path,
			sourcePath: activeFile?.path ?? path,
		});
	}

	async onOpen() {
		this.unsubscribeIndexingState = this.deps.subscribeIndexingState((snapshot) => {
			const previous = this.indexingState;
			this.indexingState = snapshot;
			this.updateLiveBanner();

			if (this.shouldRefreshResults(previous, snapshot)) {
				this.scheduleRefresh();
			}
		});

		await this.render();
	}

	async render() {
		this.containerEl.empty();
		const content = this.containerEl.createDiv({cls: "tag-container"});
		await this.renderContent(content);
	}

	private renderLoading(container: HTMLElement) {
		return container.createDiv({
			cls: "tree-item-self",
			text: "Loading similar notes...",
		});
	}

	private renderMessage(container: HTMLElement, text: string, extraCls?: string) {
		container.createDiv({
			cls: extraCls ? `empty-message ${extraCls}` : "empty-message",
			text,
		});
	}

	private renderIndexingBanner(container: HTMLElement) {
		const banner = this.indexingState.banner;
		const existing = container.querySelector(".similarity-index-banner");
		if (!this.shouldShowIndexingBanner()) {
			existing?.remove();
			return;
		}

		const bannerEl = existing instanceof HTMLElement
			? existing
			: container.insertBefore(createDiv(), container.firstChild);

		bannerEl.className = `similarity-index-banner similarity-index-banner-${banner.kind}`;
		bannerEl.empty();
		bannerEl.createDiv({
			cls: "similarity-index-banner-message",
			text: banner.message,
		});

		if (banner.total > 0) {
			const progressRow = bannerEl.createDiv({cls: "similarity-index-banner-progress"});
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

	private renderRetryAction(container: HTMLElement) {
		const actions = container.createDiv({cls: "related-notes-actions"});
		const retryButton = actions.createEl("button", {
			cls: "mod-cta related-notes-button",
			text: "Retry indexing",
		});

		retryButton.addEventListener("click", () => {
			void this.startIndexing();
		});
	}

	private async renderContent(targetContainer: HTMLElement, options: { showLoading?: boolean } = {}) {
		const showLoading = options.showLoading ?? true;
		const workingContainer = showLoading ? targetContainer : createDiv();
		if (showLoading) {
			targetContainer.empty();
		}

		const loadingEl = showLoading ? this.renderLoading(workingContainer) : undefined;

		this.isLoading = true;
		try {
			const active = this.getActiveFileOrShowEmptyState(workingContainer, loadingEl);
			if (!active) return;
			if (!isMarkdownPath(active.path)) {
				loadingEl?.remove();
				this.renderMessage(workingContainer, "Semantic matching only supports Markdown notes. Open a .md file to see similar notes.");
				this.commitRenderedContent(targetContainer, workingContainer, showLoading);
				return;
			}

			if (await this.deps.isIgnoredPath(active.path)) {
				loadingEl?.remove();
				this.renderMessage(workingContainer, "This note is ignored by settings. Remove it from ignored paths to see related notes.");
				this.commitRenderedContent(targetContainer, workingContainer, showLoading);
				return;
			}

			const indexEmpty = await this.deps.indexRepo.isEmpty();
			const related = indexEmpty
				? []
				: await this.loadSimilarNotesForActiveFile(active.path);

			loadingEl?.remove();
			this.renderIndexingBanner(workingContainer);

			if (related.length > 0) {
				this.renderRelatedList(workingContainer, related);
				this.commitRenderedContent(targetContainer, workingContainer, showLoading);
				return;
			}

			if (this.indexingState.banner.kind === "failed") {
				this.renderMessage(
					workingContainer,
					indexEmpty
						? "Indexing stopped before any results were ready."
						: "No related notes matched yet. Indexing also hit an error, so results may be stale.",
				);
				this.renderRetryAction(workingContainer);
				this.commitRenderedContent(targetContainer, workingContainer, showLoading);
				return;
			}

			if (indexEmpty && (this.indexingState.isRunning || !this.indexingState.hasCompletedInitialIndex)) {
				this.renderMessage(workingContainer, "Indexing is underway. Related notes will appear as the queue progresses.");
				this.commitRenderedContent(targetContainer, workingContainer, showLoading);
				return;
			}

			if (!indexEmpty && (this.indexingState.isRunning || !this.indexingState.hasCompletedInitialIndex)) {
				this.renderMessage(workingContainer, "No related notes were similar enough yet. More may appear while indexing continues.");
				this.commitRenderedContent(targetContainer, workingContainer, showLoading);
				return;
			}

			if (indexEmpty) {
				this.renderMessage(workingContainer, "Your index currently has no notes. Run “Sync vault index” to rebuild it.");
				this.renderRetryAction(workingContainer);
				this.commitRenderedContent(targetContainer, workingContainer, showLoading);
				return;
			}

			this.renderMessage(workingContainer, "No related notes were similar enough to display yet.");
			this.commitRenderedContent(targetContainer, workingContainer, showLoading);
		} catch (error) {
			logError("Error fetching related notes:", error);
			if (showLoading && loadingEl) {
				loadingEl.textContent = "Failed to load related notes. Please try again.";
			}
		} finally {
			this.isLoading = false;
		}
	}

	private getActiveFileOrShowEmptyState(container: HTMLElement, loadingEl?: HTMLElement) {
		const active = this.app.workspace.getActiveFile();
		if (active) return active;

		loadingEl?.remove();
		this.renderMessage(container, "Open a note to see similar notes.", "similar-notes-no-active");
		return null;
	}

	private async loadSimilarNotesForActiveFile(notePath: string): Promise<SimilarNote[]> {
		return this.deps.getSimilarNotes({noteId: notePath});
	}

	private renderRelatedList(container: HTMLElement, related: SimilarNote[]) {
		const list = container.createDiv();

		related.forEach((note) => {
			const path = note.id;

			const listItem = list.createDiv({cls: "tree-item"});
			const itemSelf = listItem.createDiv({
				cls: "tree-item-self tag-pane-tag is-clickable",
			});
			itemSelf.addEventListener("click", () => this.openNote(path));
			itemSelf.addEventListener("mouseover", (event: MouseEvent) => {
				this.triggerHoverPreview(event, itemSelf, path);
			});

			const itemInner = itemSelf.createDiv({cls: "tree-item-inner"});

			const title = path.split("/").pop()?.replace(/\.md$/i, "") ?? path;
			const parentPath = path.includes("/") ? path.split("/").slice(0, -1).join("/") : "";
			const itemInnerText = itemInner.createDiv({cls: "tree-item-inner-text"});

			const textWrapper = itemInnerText.createDiv({cls: "related-text"});

			textWrapper.createSpan({cls: "related-title", text: title});

			if (parentPath) {
				textWrapper.createEl("small", {cls: "related-parent", text: parentPath});
			}

			const flairOuter = itemSelf.createDiv({cls: "tree-item-flair-outer"});
			flairOuter.createSpan({
				cls: "tag-pane-tag-count tree-item-flair",
				text: `${Math.round(note.score * 100)}%`,
			});
		});
	}

	private async startIndexing() {
		try {
			await this.deps.startOrRefreshIndexSync({awaitCompletion: false});
		} catch (error) {
			logError("Error starting indexing:", error);
			new Notice("Failed to start indexing. See console for details.");
		}
	}

	private scheduleRefresh() {
		if (this.refreshTimer || this.isLoading) {
			return;
		}

		const elapsed = Date.now() - this.lastAutoRefreshAt;
		const delay = Math.max(0, 1500 - elapsed);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = undefined;
			void this.refresh({background: true});
		}, delay);
	}

	async refresh(args: { background?: boolean } = {}) {
		if (this.isLoading) return;
		const contentContainer = this.containerEl.querySelector(".tag-container");
		if (contentContainer) {
			this.lastAutoRefreshAt = Date.now();
			await this.renderContent(contentContainer as HTMLElement, {
				showLoading: !args.background,
			});
		}
	}

	private commitRenderedContent(targetContainer: HTMLElement, workingContainer: HTMLElement, showLoading: boolean) {
		if (showLoading) {
			return;
		}

		targetContainer.empty();
		while (workingContainer.firstChild) {
			targetContainer.appendChild(workingContainer.firstChild);
		}
	}

	private updateLiveBanner() {
		const contentContainer = this.containerEl.querySelector(".tag-container");
		if (!(contentContainer instanceof HTMLElement)) {
			return;
		}

		this.renderIndexingBanner(contentContainer);
	}

	private shouldShowIndexingBanner(): boolean {
		const {banner, total} = this.indexingState;
		if (banner.kind === "hidden" || banner.kind === "failed") {
			return banner.kind === "failed";
		}

		return total > SimilarNotesListView.MIN_ITEMS_FOR_PROGRESS_BANNER - 1;
	}

	private shouldRefreshResults(previous: IndexingQueueSnapshot, snapshot: IndexingQueueSnapshot): boolean {
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

	override onClose(): Promise<void> {
		if (this.refreshTimer) {
			window.clearTimeout(this.refreshTimer);
			this.refreshTimer = undefined;
		}
		this.unsubscribeIndexingState?.();

		return Promise.resolve();
	}
}

import { ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { RelatedNotesFeed, RelatedNotesSnapshot } from "../app/relatedNotesFeed";

export function logError(message: unknown, ...optionalParams: unknown[]) {
	console.error("[Similarity]:", message, ...optionalParams);
}

export const VIEW_TYPE_SIMILARITY = "similarity";

export type SimilarNotesListViewDeps = {
	relatedNotesFeed: RelatedNotesFeed;
};

const MIN_ITEMS_FOR_INDEXING_BANNER = 8;

export class SimilarNotesListView extends ItemView {
	private snapshot: RelatedNotesSnapshot | undefined;
	private activePath: string | null = null;
	private unsubscribe?: () => void;

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
		this.containerEl.empty();
		this.containerEl.createDiv({cls: "tag-container"});

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => this.syncActiveNote()),
		);
		this.registerEvent(
			this.app.workspace.on("file-open", () => this.syncActiveNote()),
		);

		this.unsubscribe = this.deps.relatedNotesFeed.subscribe((snapshot) => {
			this.snapshot = snapshot;
			this.render();
		});

		this.syncActiveNote();
	}

	private syncActiveNote() {
		const active = this.app.workspace.getActiveFile();
		this.activePath = active?.path ?? null;
		this.deps.relatedNotesFeed.setActiveNote(this.activePath);
		this.render();
	}

	private render() {
		const container = this.containerEl.querySelector(".tag-container") as HTMLElement | null
			?? this.containerEl.createDiv({cls: "tag-container"});
		container.empty();

		if (!this.snapshot || this.snapshot.noteId !== this.activePath) {
			container.createDiv({cls: "tree-item-self", text: "Loading similar notes..."});
			return;
		}

		this.renderBanner(container, this.snapshot);

		if (this.snapshot.items.length > 0) {
			this.renderRelatedList(container, this.snapshot.items);
			return;
		}

		const {text, showRetry} = this.emptyStateFor(this.snapshot);
		if (text) this.renderMessage(container, text, this.snapshot.notice?.kind === "no-active-note" ? "similar-notes-no-active" : undefined);
		if (showRetry) this.renderRetryAction(container);
	}

	private emptyStateFor(snapshot: RelatedNotesSnapshot): { text?: string; showRetry?: boolean } {
		const notice = snapshot.notice;
		if (!notice) return {text: "No related notes were similar enough to display yet."};

		switch (notice.kind) {
			case "no-active-note":
				return {text: "Open a note to see similar notes."};
			case "unsupported-file":
				return {text: "Semantic matching only supports Markdown notes. Open a .md file to see similar notes."};
			case "ignored-path":
				return {text: "This note is ignored by settings. Remove it from ignored paths to see related notes."};
			case "warming-up":
				return {text: "Related notes will appear once the embedding model finishes loading."};
			case "fatal-error":
				return {
					text: notice.indexEmpty
						? "Indexing stopped before any results were ready."
						: "No related notes matched yet. Indexing also hit an error, so results may be stale.",
					showRetry: true,
				};
			case "empty-index":
				return {text: "Your index currently has no notes. Run “Sync vault index” to rebuild it.", showRetry: true};
			case "indexing":
				return {
					text: notice.indexEmpty
						? "Indexing is underway. Related notes will appear as the queue progresses."
						: "No related notes were similar enough yet. More may appear while indexing continues.",
				};
		}
	}

	private renderMessage(container: HTMLElement, text: string, extraCls?: string) {
		container.createDiv({
			cls: extraCls ? `empty-message ${extraCls}` : "empty-message",
			text,
		});
	}

	private renderBanner(container: HTMLElement, snapshot: RelatedNotesSnapshot) {
		const notice = snapshot.notice;
		if (!notice) return;

		const message = notice.kind === "warming-up"
			? "Setting up..."
			: notice.kind === "indexing" && notice.total > MIN_ITEMS_FOR_INDEXING_BANNER - 1
				? "Optimizing your experience. Results may shift as more notes are processed."
				: undefined;
		if (!message) return;

		const bannerEl = container.insertBefore(createDiv(), container.firstChild);
		bannerEl.className = "similarity-index-banner";
		bannerEl.createDiv({
			cls: "similarity-index-banner-message",
			text: message,
		});

		if (notice.kind === "warming-up" && notice.progress !== null) {
			const progressRow = bannerEl.createDiv({cls: "similarity-index-banner-progress"});
			progressRow.createEl("progress", {
				cls: "similarity-index-banner-bar",
				attr: {max: "100", value: String(Math.min(notice.progress, 100))},
			});
		} else if (notice.kind === "indexing") {
			const progressRow = bannerEl.createDiv({cls: "similarity-index-banner-progress"});
			progressRow.createEl("progress", {
				cls: "similarity-index-banner-bar",
				attr: {max: String(notice.total), value: String(Math.min(notice.processed, notice.total))},
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
			this.deps.relatedNotesFeed.retryIndexing().catch((error) => {
				logError("Error starting indexing:", error);
				new Notice("Failed to start indexing. See console for details.");
			});
		});
	}

	private renderRelatedList(container: HTMLElement, related: RelatedNotesSnapshot["items"]) {
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

	override onClose(): Promise<void> {
		this.unsubscribe?.();
		return Promise.resolve();
	}
}

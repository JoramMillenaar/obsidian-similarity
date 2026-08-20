import { ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { SimilarNotesFeed, SimilarNotesSnapshot } from "../app/similarNotesFeed";
import { BackendState } from "../app/backendState";
import { BannerState } from "../app/backendBanner";
import { textForNotice } from "./similarNoticeText";

export function logError(message: unknown, ...optionalParams: unknown[]) {
	console.error("[Similarity]:", message, ...optionalParams);
}

export const VIEW_TYPE_SIMILARITY = "similarity";

export type SimilarNotesListViewDeps = {
	similarNotesFeed: SimilarNotesFeed;
	backendState: BackendState;
};

const HIDDEN_BANNER: BannerState = {visible: false, message: "", processed: 0, total: 0};

export class SimilarNotesListView extends ItemView {
	private snapshot: SimilarNotesSnapshot | undefined;
	private activePath: string | null = null;
	private banner: BannerState = HIDDEN_BANNER;
	private unsubscribeSnapshot?: () => void;
	private unsubscribeBanner?: () => void;

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

		this.unsubscribeSnapshot = this.deps.similarNotesFeed.subscribe((snapshot) => {
			this.snapshot = snapshot;
			this.render();
		});
		this.unsubscribeBanner = this.deps.backendState.subscribeBanner((banner) => {
			this.banner = banner;
			this.render();
		});

		this.syncActiveNote();
	}

	private syncActiveNote() {
		const active = this.app.workspace.getActiveFile();
		this.activePath = active?.path ?? null;
		this.deps.similarNotesFeed.setActiveNote(this.activePath);
		this.render();
	}

	private render() {
		const container = this.containerEl.querySelector(".tag-container") as HTMLElement | null
			?? this.containerEl.createDiv({cls: "tag-container"});
		container.empty();

		this.renderTopBanner(container);

		if (!this.snapshot || this.snapshot.noteId !== this.activePath) {
			container.createDiv({cls: "tree-item-self", text: "Loading similar notes..."});
			return;
		}

		if (this.snapshot.items.length > 0) {
			this.renderRelatedList(container, this.snapshot.items);
			return;
		}

		const {text, showRetry} = this.emptyStateFor(this.snapshot);
		if (text) this.renderMessage(container, text, this.snapshot.notice?.kind === "no-active-note" ? "similar-notes-no-active" : undefined);
		if (showRetry) this.renderRetryAction(container);
	}

	private emptyStateFor(snapshot: SimilarNotesSnapshot): { text?: string; showRetry?: boolean } {
		const notice = snapshot.notice;
		if (!notice) return {text: "No related notes were similar enough to display yet."};

		return {
			text: textForNotice(notice),
			showRetry: notice.kind === "fatal-error" || notice.kind === "empty-index",
		};
	}

	private renderMessage(container: HTMLElement, text: string, extraCls?: string) {
		container.createDiv({
			cls: extraCls ? `empty-message ${extraCls}` : "empty-message",
			text,
		});
	}

	private renderTopBanner(container: HTMLElement) {
		const banner = this.banner;
		if (!banner.visible) return;

		const bannerEl = container.insertBefore(createDiv(), container.firstChild);
		bannerEl.className = "similarity-index-banner";
		bannerEl.createDiv({
			cls: "similarity-index-banner-message",
			text: banner.message,
		});

		if (banner.total > 0) {
			const progressRow = bannerEl.createDiv({cls: "similarity-index-banner-progress"});
			progressRow.createEl("progress", {
				cls: "similarity-index-banner-bar",
				attr: {max: String(banner.total), value: String(Math.min(banner.processed, banner.total))},
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
			this.deps.similarNotesFeed.retryIndexing().catch((error) => {
				logError("Error starting indexing:", error);
				new Notice("Failed to start indexing. See console for details.");
			});
		});
	}

	private renderRelatedList(container: HTMLElement, related: SimilarNotesSnapshot["items"]) {
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
		this.unsubscribeSnapshot?.();
		this.unsubscribeBanner?.();
		return Promise.resolve();
	}
}

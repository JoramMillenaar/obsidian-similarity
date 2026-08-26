import { ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { SimilarNotesFeed, SimilarNotesSnapshot } from "../search/similarNotesFeed";
import { StatusHub } from "../status/statusHub";
import { BannerState, subscribeBanner } from "./banner";
import { textForNotice } from "./similarNoticeText";
import { VIEW_TYPE_SIMILARITY } from "../constants";

export { VIEW_TYPE_SIMILARITY };

export function logError(message: unknown, ...optionalParams: unknown[]) {
	console.error("[Similarity]:", message, ...optionalParams);
}



const LOADING_TEXT = "Loading similar notes...";

type RetryAction = {
	label: string;
	run: () => Promise<void>;
	failureNotice: string;
};

type MessageState = {
	text?: string;
	cls?: string;
	retry?: RetryAction;
};

export type SimilarNotesListViewDeps = {
	similarNotesFeed: SimilarNotesFeed;
	statusHub: StatusHub;
};

function signatureForItems(items: SimilarNotesSnapshot["items"]): string {
	return items.map((item) => `${item.id} ${item.score.toFixed(4)}`).join("|");
}

function signatureForMessage(message: MessageState): string {
	return [message.text ?? "", message.cls ?? "", message.retry?.label ?? ""].join("|");
}

export class SimilarNotesListView extends ItemView {
	private snapshot: SimilarNotesSnapshot | undefined;
	private activePath: string | null = null;
	private bannerEl?: HTMLElement;
	private listEl?: HTMLElement;
	private messageEl?: HTMLElement;
	private renderedItems: string | null = null;
	private renderedMessage: string | null = null;
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
		const root = this.containerEl.createDiv({cls: "tag-container"});
		this.bannerEl = root.createDiv({cls: "similarity-index-banner is-hidden"});
		const body = root.createDiv();
		this.listEl = body.createDiv();
		this.messageEl = body.createDiv();

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => this.syncActiveNote()),
		);
		this.registerEvent(
			this.app.workspace.on("file-open", () => this.syncActiveNote()),
		);
		this.registerEvent(
			this.app.vault.on("rename", () => this.syncActiveNote()),
		);

		this.unsubscribeSnapshot = this.deps.similarNotesFeed.subscribe((snapshot) => {
			this.snapshot = snapshot;
			this.renderBody();
		});
		this.unsubscribeBanner = subscribeBanner(this.deps.statusHub, (banner) => this.renderBanner(banner));

		this.syncActiveNote();
	}

	private syncActiveNote() {
		const active = this.app.workspace.getActiveFile();
		this.activePath = active?.path ?? null;
		this.deps.similarNotesFeed.setActiveNote(this.activePath);
		this.renderBody();
	}

	private renderBody() {
		if (!this.snapshot || this.snapshot.noteId !== this.activePath) {
			this.renderRelatedList([]);
			this.renderMessage({text: LOADING_TEXT, cls: "tree-item-self"});
			return;
		}

		this.renderRelatedList(this.snapshot.items);

		if (this.snapshot.items.length > 0) {
			this.renderMessage({});
			return;
		}

		this.renderMessage(this.emptyStateFor(this.snapshot));
	}

	private emptyStateFor(snapshot: SimilarNotesSnapshot): MessageState {
		const notice = snapshot.notice;
		if (!notice) return {text: "No related notes were similar enough to display yet."};

		const text = textForNotice(notice);
		if (notice.kind === "model-error") {
			return {
				text,
				retry: {
					label: "Try again",
					run: () => this.deps.similarNotesFeed.retryModelLoad(),
					failureNotice: "Could not load the model. See console for details.",
				},
			};
		}
		if (notice.kind === "fatal-error" || notice.kind === "empty-index") {
			return {
				text,
				retry: {
					label: "Retry indexing",
					run: () => this.deps.similarNotesFeed.retryIndexing(),
					failureNotice: "Failed to start indexing. See console for details.",
				},
			};
		}
		if (notice.kind === "no-active-note") {
			return {text, cls: "empty-message similar-notes-no-active"};
		}
		return {text};
	}

	private renderMessage(message: MessageState) {
		const container = this.messageEl;
		if (!container) return;

		const signature = signatureForMessage(message);
		if (signature === this.renderedMessage) return;
		this.renderedMessage = signature;

		container.empty();
		if (message.text) {
			container.createDiv({
				cls: message.cls ?? "empty-message",
				text: message.text,
			});
		}
		if (message.retry) this.renderRetryAction(container, message.retry);
	}

	private renderBanner(banner: BannerState) {
		const bannerEl = this.bannerEl;
		if (!bannerEl) return;

		bannerEl.empty();
		bannerEl.toggleClass("is-hidden", !banner.visible);
		if (!banner.visible) return;

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

	private renderRetryAction(container: HTMLElement, retry: RetryAction) {
		const actions = container.createDiv({cls: "related-notes-actions"});
		const retryButton = actions.createEl("button", {
			cls: "mod-cta related-notes-button",
			text: retry.label,
		});

		retryButton.addEventListener("click", () => {
			retryButton.setAttr("disabled", "true");
			retry.run()
				.catch((error) => {
					logError(`${retry.label} failed:`, error);
					new Notice(retry.failureNotice);
				})
				.finally(() => retryButton.removeAttribute("disabled"));
		});
	}

	private renderRelatedList(related: SimilarNotesSnapshot["items"]) {
		const list = this.listEl;
		if (!list) return;

		const signature = signatureForItems(related);
		if (signature === this.renderedItems) return;
		this.renderedItems = signature;

		list.empty();

		related.forEach((note) => {
			const path = note.id;

			const listItem = list.createDiv({cls: "tree-item"});
			const itemSelf = listItem.createDiv({
				cls: "tree-item-self tag-pane-tag is-clickable",
			});
			this.bindOpenOnClick(itemSelf, path);
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

	private bindOpenOnClick(itemSelf: HTMLElement, path: string) {
		let openedOnPointerDown = false;

		itemSelf.addEventListener("pointerdown", (event: PointerEvent) => {
			if (event.button !== 0 || event.pointerType === "touch") return;
			openedOnPointerDown = true;
			this.openNote(path);
		});

		itemSelf.addEventListener("click", () => {
			if (openedOnPointerDown) {
				openedOnPointerDown = false;
				return;
			}
			this.openNote(path);
		});
	}

	override onClose(): Promise<void> {
		this.unsubscribeSnapshot?.();
		this.unsubscribeBanner?.();
		return Promise.resolve();
	}
}

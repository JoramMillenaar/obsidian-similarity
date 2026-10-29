import { ItemView, Menu, Notice, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import { SimilarNotesFeed, SimilarNotesSnapshot } from "../search/similarNotesFeed";
import { StatusHub } from "../status/statusHub";
import { mountBanner } from "./bannerView";
import { textForNotice } from "./similarNoticeText";
import { VIEW_TYPE_SIMILARITY } from "../constants";
import { RelatedNote, SimilarityTier } from "../types";
import { FEEDBACK_ACTIONS, OpenFeedback } from "./FeedbackModal";
import { renderSimilarityBar } from "./similarityBar";
import { noteAgeText } from "./noteAge";
import { groupByTier } from "./tierSections";
import { SIMILARITY_TIER_LABELS } from "../core/vector/similarityTier";

export { VIEW_TYPE_SIMILARITY };

function logError(message: unknown, ...optionalParams: unknown[]) {
	console.error("[Similarity]", message, ...optionalParams);
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
	openSearchModal: () => void;
	openSettings: () => void;
	openFeedback: OpenFeedback;
};

const TRUNCATION_NOTICE_TEXT = "Only part of this large note was used for the search.";

function signatureForItems(items: SimilarNotesSnapshot["items"]): string {
	return items.map((item) => `${item.id} ${item.score.toFixed(4)}`).join("|");
}

function signatureForMessage(message: MessageState): string {
	return [message.text ?? "", message.cls ?? "", message.retry?.label ?? ""].join("|");
}

export class SimilarNotesListView extends ItemView {
	private snapshot: SimilarNotesSnapshot | undefined;
	private activePath: string | null = null;
	private truncationNoticeEl?: HTMLElement;
	private listEl?: HTMLElement;
	private messageEl?: HTMLElement;
	private renderedItems: string | null = null;
	private renderedMessage: string | null = null;
	private unsubscribeSnapshot?: () => void;
	private unsubscribeBanner?: () => void;
	private collapsedTiers = new Set<SimilarityTier>();

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

	private createNavActionButton(container: HTMLElement, icon: string, label: string, onClick: (event: MouseEvent) => void) {
		const button = container.createEl("button", {
			cls: "clickable-icon nav-action-button",
			attr: {"aria-label": label},
		});
		setIcon(button, icon);
		button.addEventListener("click", onClick);
		return button;
	}

	private openFeedbackMenu = (event: MouseEvent) => {
		const menu = new Menu();
		for (const action of FEEDBACK_ACTIONS) {
			menu.addItem((item) => {
				item.setTitle(action.label).setIcon(action.icon).onClick(() => action.run(this.deps.openFeedback));
			});
		}
		menu.showAtMouseEvent(event);
	};

	async onOpen() {
		this.containerEl.querySelector(":scope > .nav-header")?.remove();
		const navHeader = this.containerEl.createDiv({cls: "nav-header"});
		const navButtons = navHeader.createDiv({cls: "nav-buttons-container"});
		this.createNavActionButton(navButtons, "search", "Open semantic search", () => this.deps.openSearchModal());
		this.createNavActionButton(navButtons, "settings", "Open plugin settings", () => this.deps.openSettings());
		this.createNavActionButton(navButtons, "message-square", "Send feedback", this.openFeedbackMenu);
		this.containerEl.prepend(navHeader);

		this.contentEl.empty();
		this.unsubscribeBanner?.();
		this.unsubscribeBanner = mountBanner(this.contentEl, this.deps.statusHub, {onOpenSettings: () => this.deps.openSettings()});
		this.truncationNoticeEl = this.contentEl.createDiv({cls: "similarity-truncation-notice is-hidden"});
		const body = this.contentEl.createDiv();
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

		this.syncActiveNote();
	}

	private syncActiveNote() {
		const active = this.app.workspace.getActiveFile();
		this.activePath = active?.path ?? null;
		this.deps.similarNotesFeed.setActiveNote(this.activePath);
		this.renderBody();
	}

	private renderTruncationNotice(visible: boolean) {
		const container = this.truncationNoticeEl;
		if (!container) return;

		container.toggleClass("is-hidden", !visible);
		if (!visible) return;
		if (container.childElementCount > 0) return;

		container.createDiv({
			cls: "similarity-truncation-notice-message",
			text: TRUNCATION_NOTICE_TEXT,
		});
		const link = container.createEl("a", {
			cls: "similarity-truncation-notice-link",
			text: "Raise the character limits in the settings",
		});
		link.addEventListener("click", (event) => {
			event.preventDefault();
			this.deps.openSettings();
		});
	}

	private renderBody() {
		const current = this.snapshot?.noteId === this.activePath;
		this.renderTruncationNotice(current && this.snapshot?.truncated === true);

		if (!this.snapshot || !current) {
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

		for (const section of groupByTier(related)) {
			const sectionEl = list.createDiv({cls: "tree-item similarity-tier-section"});
			const children = this.renderSectionHeader(sectionEl, section.tier, section.items.length);
			section.items.forEach((note) => this.renderRelatedItem(children, note));
		}
	}

	private renderSectionHeader(sectionEl: HTMLElement, tier: SimilarityTier, count: number): HTMLElement {
		const header = sectionEl.createDiv({cls: "tree-item-self is-clickable mod-collapsible"});
		const icon = header.createDiv({cls: "tree-item-icon collapse-icon"});
		setIcon(icon, "right-triangle");
		header.createDiv({cls: "tree-item-inner", text: SIMILARITY_TIER_LABELS[tier]});
		header.createDiv({cls: "tree-item-flair-outer"}).createSpan({cls: "tree-item-flair", text: String(count)});

		const children = sectionEl.createDiv({cls: "tree-item-children"});
		const applyCollapsed = (collapsed: boolean) => {
			header.toggleClass("is-collapsed", collapsed);
			icon.toggleClass("is-collapsed", collapsed);
			if (collapsed) children.hide();
			else children.show();
		};
		applyCollapsed(this.collapsedTiers.has(tier));

		header.addEventListener("click", () => {
			const collapsed = !this.collapsedTiers.has(tier);
			if (collapsed) this.collapsedTiers.add(tier);
			else this.collapsedTiers.delete(tier);
			applyCollapsed(collapsed);
		});
		return children;
	}

	private renderRelatedItem(list: HTMLElement, note: RelatedNote) {
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

		const age = noteAgeText(this.app, path);
		if (parentPath || age) {
			const meta = textWrapper.createEl("small", {cls: "related-parent"});
			if (parentPath) meta.appendText(parentPath);
			if (age) meta.createSpan({cls: "related-age", text: parentPath ? ` · ${age}` : age});
		}

		const flairOuter = itemSelf.createDiv({cls: "tree-item-flair-outer"});
		renderSimilarityBar(flairOuter, note);
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

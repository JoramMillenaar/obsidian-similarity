import { App, HoverParent, HoverPopover } from "obsidian";
import { RelatedNote } from "../types";
import { GetMatchedPassageUseCase } from "../search/getMatchedPassage";
import { locatePassage } from "../core/text/locatePassage";
import { OriginHighlighter } from "./originHighlight";

/** The CSS custom highlight the matched passage gets inside a preview (styled in styles.css). */
const TARGET_HIGHLIGHT = "similarity-target";

/** The project's DOM typings predate the registry's map and the highlight's set methods, which Electron's Chromium has. */
type RangeSet = { add(range: Range): void; delete(range: Range): boolean };
const highlights = () => CSS.highlights as unknown as Map<string, RangeSet>;

export type MatchPreviewDeps = {
	getMatchedPassage: GetMatchedPassageUseCase;
	originHighlighter: OriginHighlighter;
	/** The hover link source the rows belong to, so the page-preview settings for it apply. */
	hoverSource: string;
};

/**
 * Shows a result in Obsidian's page preview (on Mod-hover, or however that source is set up) with the
 * result's matched passage highlighted, and highlights the open note's side of the match while it shows.
 */
export class MatchPreview {
	constructor(private readonly app: App, private readonly deps: MatchPreviewDeps) {
	}

	bind(row: HTMLElement, note: RelatedNote, queryNoteId: string | null): void {
		// Core reads the preview's `state` only once it loads the note, a moment after the hover,
		// so where to scroll can still be filled in while it waits.
		const state: { scroll?: number } = {};
		let target: Promise<string | null> | null = null;

		// Core assigns a new popover to its parent's `hoverPopover`; the setter is told the moment it exists.
		let popover: HoverPopover | null = null;
		const hoverParent: HoverParent = {
			get hoverPopover() {
				return popover;
			},
			set hoverPopover(next) {
				popover = next;
				if (next) onPopover(next);
			},
		};

		const onPopover = (shown: HoverPopover) => {
			let origin: number | null = null;
			if (queryNoteId !== null && note.queryPassage) {
				origin = this.deps.originHighlighter.show(queryNoteId, this.deps.getMatchedPassage(queryNoteId, note.queryPassage));
			}
			const stopTarget = this.highlightTarget(shown, target ?? Promise.resolve(null), state);
			const stopFlash = suppressBlockFlash(shown);
			shown.register(() => {
				stopTarget();
				stopFlash();
				if (origin !== null) this.deps.originHighlighter.clear(origin);
			});
		};

		row.addEventListener("mouseover", (event: MouseEvent) => {
			target ??= this.prepareTarget(note, state);
			this.app.workspace.trigger("hover-link", {
				event,
				source: this.deps.hoverSource,
				hoverParent,
				targetEl: row,
				linktext: note.id,
				sourcePath: queryNoteId ?? note.id,
				state,
			});
		});
	}

	/** The result's matched passage, with the line it starts on put into `state` for the preview to scroll to. */
	private async prepareTarget(note: RelatedNote, state: { scroll?: number }): Promise<string | null> {
		if (!note.passage) return null;
		const text = await this.deps.getMatchedPassage(note.id, note.passage);
		const file = this.app.vault.getFileByPath(note.id);
		if (!text || !file) return text;

		const content = await this.app.vault.cachedRead(file);
		const range = locatePassage(content, text);
		if (range) state.scroll = content.slice(0, range[0]).split("\n").length - 1;
		return text;
	}

	/**
	 * Marks the passage in the preview once it's rendered there (reading view renders lazily, so this
	 * retries as the preview's DOM changes). Returns what removes the mark again.
	 */
	private highlightTarget(popover: HoverPopover, target: Promise<string | null>, state: { scroll?: number }): () => void {
		let range: Range | null = null;
		let stopped = false;
		const observer = new MutationObserver(() => tryHighlight());

		const tryHighlight = () => {
			if (stopped || range) return;
			void target.then((text) => {
				if (stopped || range || !text) return;
				const container = popover.hoverEl.querySelector<HTMLElement>(".markdown-preview-view") ?? popover.hoverEl;
				range = rangeOf(container, text);
				if (!range) return;

				observer.disconnect();
				const highlight = highlights().get(TARGET_HIGHLIGHT) ?? (new Highlight() as unknown as RangeSet);
				highlight.add(range);
				highlights().set(TARGET_HIGHLIGHT, highlight);
				// Without a line to scroll to (it wasn't known in time), bring the passage into view directly.
				if (state.scroll === undefined) range.startContainer.parentElement?.scrollIntoView({block: "center"});
			});
		};

		observer.observe(popover.hoverEl, {childList: true, subtree: true, characterData: true});
		tryHighlight();

		return () => {
			stopped = true;
			observer.disconnect();
			if (range) highlights().get(TARGET_HIGHLIGHT)?.delete(range);
		};
	}
}

/**
 * Core flashes the whole block it scrolls a preview to (`state.scroll`), which would compete with the
 * passage's own highlight. The class is taken off as soon as it's added, before it's ever painted.
 */
function suppressBlockFlash(popover: HoverPopover): () => void {
	const observer = new MutationObserver((mutations) => {
		for (const {target} of mutations) {
			if (target.instanceOf(HTMLElement) && target.hasClass("is-flashing")) target.removeClass("is-flashing");
		}
	});
	observer.observe(popover.hoverEl, {subtree: true, attributes: true, attributeFilter: ["class"]});
	return () => observer.disconnect();
}

/** The DOM range holding a passage of rendered text, matched by its words like {@link locatePassage}. */
function rangeOf(container: HTMLElement, passage: string): Range | null {
	const nodes: Text[] = [];
	const starts: number[] = [];
	let text = "";
	const walker = container.doc.createTreeWalker(container, NodeFilter.SHOW_TEXT);
	while (walker.nextNode()) {
		const node = walker.currentNode as Text;
		// Text nodes are joined by a break, so words of adjacent blocks don't run together.
		if (nodes.length) text += "\n";
		starts.push(text.length);
		nodes.push(node);
		text += node.data;
	}

	const found = locatePassage(text, passage);
	if (!found) return null;

	const at = (offset: number, isEnd: boolean): [Text, number] => {
		let i = nodes.length - 1;
		while (i > 0 && (isEnd ? starts[i] >= offset : starts[i] > offset)) i--;
		return [nodes[i], Math.min(offset - starts[i], nodes[i].data.length)];
	};
	const range = container.doc.createRange();
	range.setStart(...at(found[0], false));
	range.setEnd(...at(found[1], true));
	return range;
}

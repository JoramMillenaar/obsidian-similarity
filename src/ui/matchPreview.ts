import { App, HoverParent, HoverPopover } from "obsidian";
import { RelatedNote } from "../types";
import { GetMatchedPassageUseCase } from "../search/getMatchedPassage";
import { locatePassage } from "../core/text/locatePassage";
import { OriginHighlighter } from "./originHighlight";
import { markRenderedPassage } from "./renderedHighlight";

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
			const stopTarget = markRenderedPassage(shown.hoverEl, target ?? Promise.resolve(null), (range) => {
				// Without a line to scroll to (it wasn't known in time), bring the passage into view directly.
				if (state.scroll === undefined) range.startContainer.parentElement?.scrollIntoView({block: "center"});
			});
			shown.register(() => {
				stopTarget();
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
}

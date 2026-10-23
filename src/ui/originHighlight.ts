import { App, Editor, EditorRange, MarkdownView } from "obsidian";
import { locatePassage } from "../core/text/locatePassage";

const HIGHLIGHT_CLASS = "similarity-origin-highlight";

/** Editor methods core uses for its own search highlights; not in obsidian.d.ts, so they may change. */
type HighlightingEditor = Editor & {
	addHighlights?(ranges: EditorRange[], cls: string, replace: boolean, unfold: boolean): void;
	removeHighlights?(cls?: string): void;
};

type Shown = {
	view: MarkdownView;
	noteId: string;
	scroll: unknown;
};

/**
 * Highlights the passage of an open note that a result matched on, while that result is pointed at
 * or previewed, and puts the note back where it was scrolled when it no longer is.
 */
export class OriginHighlighter {
	private shown: Shown | null = null;
	private request = 0;

	constructor(private readonly app: App) {
	}

	/**
	 * Shows the passage once `passage` resolves, unless another show or clear came first.
	 * Returns a token that clears this highlight only, not one shown after it.
	 */
	show(noteId: string, passage: Promise<string | null>): number {
		const request = ++this.request;
		void passage.then((text) => {
			if (request !== this.request || !text) return;
			this.highlight(noteId, text);
		}).catch(() => undefined);
		return request;
	}

	/** Clears the highlight; given a token from {@link show}, only while that show is still the latest. */
	clear(token?: number): void {
		if (token !== undefined && token !== this.request) return;
		this.request++;
		const shown = this.shown;
		this.shown = null;
		// The note may have been navigated away from, e.g. by opening the result in the same tab.
		if (!shown || shown.view.file?.path !== shown.noteId) return;

		(shown.view.editor as HighlightingEditor).removeHighlights?.(HIGHLIGHT_CLASS);
		shown.view.setEphemeralState({scroll: shown.scroll});
	}

	private highlight(noteId: string, text: string): void {
		const view = this.viewOf(noteId);
		if (!view) return;

		const content = view.getViewData();
		const range = locatePassage(content, text);
		if (!range) return;

		const previous = this.shown;
		const scroll = previous?.view === view ? previous.scroll : view.getEphemeralState().scroll;
		if (previous && previous.view !== view) this.clear();

		if (view.getMode() === "source") {
			// Core's own `match` state would also move the cursor here, so the highlight is added directly.
			const editor = view.editor as HighlightingEditor;
			if (!editor.addHighlights) return;
			const highlight = {from: editor.offsetToPos(range[0]), to: editor.offsetToPos(range[1])};
			editor.addHighlights([highlight], HIGHLIGHT_CLASS, true, false);
			editor.scrollIntoView(highlight, true);
		} else {
			// Reading view scrolls to the passage's block and flashes it briefly.
			view.setEphemeralState({match: {content, matches: [range]}});
		}
		this.shown = {view, noteId, scroll};
	}

	private viewOf(noteId: string): MarkdownView | null {
		const recent = this.app.workspace.getMostRecentLeaf()?.view;
		if (recent instanceof MarkdownView && recent.file?.path === noteId) return recent;

		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			if (leaf.view instanceof MarkdownView && leaf.view.file?.path === noteId) return leaf.view;
		}
		return null;
	}
}

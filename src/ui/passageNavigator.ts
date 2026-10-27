import { App, MarkdownView, TFile, WorkspaceLeaf } from "obsidian";
import { RelatedNote } from "../types";
import { GetMatchedPassageUseCase } from "../search/getMatchedPassage";
import { locatePassage } from "../core/text/locatePassage";
import { markRenderedPassage } from "./renderedHighlight";

/**
 * Opens results at the passage they matched, highlighted, the way core opens its own search results.
 * Editing views get core's search-match navigation: the cursor moves to the passage, which stays
 * highlighted until a click in the note or Esc. Reading view would only flash the passage's whole
 * block, so there the passage itself is marked, as in the Mod-hover preview, until the same click or Esc.
 * Lives as long as the plugin, since the mark outlasts whatever opened the note.
 */
export class PassageNavigator {
	private unmark: (() => void) | null = null;

	constructor(private readonly app: App, private readonly getMatchedPassage: GetMatchedPassageUseCase) {
	}

	/** Opens `note` in `leaf`: at its matched passage, or as usual when that can't be found anymore. */
	async open(leaf: WorkspaceLeaf, file: TFile, note: RelatedNote): Promise<void> {
		this.clear();
		const passage = note.passage ? await this.getMatchedPassage(note.id, note.passage).catch(() => null) : null;
		const content = passage ? await this.app.vault.cachedRead(file) : "";
		const range = passage ? locatePassage(content, passage) : null;
		if (!passage || !range) {
			await leaf.openFile(file);
			return;
		}

		await leaf.openFile(file, {eState: {match: {content, matches: [range]}}});
		const view = leaf.view;
		if (view instanceof MarkdownView && view.file === file && view.getMode() === "preview") this.markInReading(view, passage);
	}

	/** Takes the reading-view mark off, if one is showing. */
	clear(): void {
		const unmark = this.unmark;
		this.unmark = null;
		unmark?.();
	}

	private markInReading(view: MarkdownView, passage: string): void {
		const root = view.previewMode.containerEl;
		const path = view.file?.path;
		const stopMark = markRenderedPassage(root, Promise.resolve(passage));

		const clear = () => this.clear();
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape" && this.app.workspace.getActiveViewOfType(MarkdownView) === view) this.clear();
		};
		// Also gone once the note is left, closed or switched to editing, where the mark can't be seen.
		const onLayoutChange = () => {
			if (!root.isConnected || view.file?.path !== path || view.getMode() !== "preview") this.clear();
		};
		root.addEventListener("pointerdown", clear);
		root.win.addEventListener("keydown", onKeyDown);
		const refs = [
			this.app.workspace.on("layout-change", onLayoutChange),
			this.app.workspace.on("file-open", onLayoutChange),
		];

		this.unmark = () => {
			stopMark();
			root.removeEventListener("pointerdown", clear);
			root.win.removeEventListener("keydown", onKeyDown);
			for (const ref of refs) this.app.workspace.offref(ref);
		};
	}
}

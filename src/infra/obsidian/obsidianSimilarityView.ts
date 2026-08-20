import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_SIMILARITY } from "../../ui/SimilarNotesListView";
import { ActivateOptions, SimilarityView } from "../../ports";
import { SimilarNotesFeed } from "../../app/similarNotesFeed";

export class ObsidianSimilarityView implements SimilarityView {
	constructor(private readonly plugin: Plugin, private readonly similarNotesFeed: SimilarNotesFeed) {
	}

	async activate(options: ActivateOptions = {}): Promise<void> {
		const {workspace} = this.plugin.app;
		const {reveal = true, focus = false} = options;

		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_SIMILARITY)[0];

		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			if (!leaf) {
				new Notice("Unable to activate similarity view.");
				return;
			}

			await leaf.setViewState({
				type: VIEW_TYPE_SIMILARITY,
				active: reveal || focus,
			});
		}

		if (reveal) {
			await workspace.revealLeaf(leaf);
		}

		if (focus) {
			workspace.setActiveLeaf(leaf, {focus: true});
		}
	}

	refreshResults(): void {
		this.similarNotesFeed.refresh();
	}
}

import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_SEMANTIC_GRAPH } from "../ui/SemanticGraphView";

/**
 * Opens the semantic graph in a main (center) leaf, reusing an existing graph
 * leaf if one is already open, and reveals it.
 */
export async function activateGraphView(plugin: Plugin): Promise<WorkspaceLeaf | null> {
	const {workspace} = plugin.app;

	let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_SEMANTIC_GRAPH)[0] ?? null;

	if (!leaf) {
		leaf = workspace.getLeaf(true);
		if (!leaf) {
			new Notice("Unable to open the semantic graph view.");
			return null;
		}
		await leaf.setViewState({type: VIEW_TYPE_SEMANTIC_GRAPH, active: true});
	}

	await workspace.revealLeaf(leaf);
	return leaf;
}

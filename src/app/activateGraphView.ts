import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_SEMANTIC_GRAPH } from "../ui/SemanticGraphView";

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

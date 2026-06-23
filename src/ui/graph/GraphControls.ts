import { Setting } from "obsidian";
import { GraphSettings } from "../../types";

/** How a settings change should be applied, cheapest first. */
export type GraphSettingsChangeKind =
	| "rebuild"  // edge set changed (N / minScore) — recompute via the use case
	| "filter"   // visible node/edge set changed (orphans) — re-derive locally
	| "forces"   // simulation forces changed — reheat
	| "render";  // purely visual — redraw

export type GraphControlsDeps = {
	getSettings: () => GraphSettings;
	onChange: (patch: Partial<GraphSettings>, kind: GraphSettingsChangeKind) => void;
	onRestoreDefaults: () => void;
};

/**
 * Renders the in-view settings panel that mirrors Obsidian's graph controls
 * (Filters / Display / Forces), plus the similarity-specific "links per node"
 * and "minimum similarity" controls. Pure presentation: it reads the current
 * settings and emits change patches; it does not persist anything itself.
 */
export class GraphControls {
	constructor(private readonly deps: GraphControlsDeps) {
	}

	render(container: HTMLElement): void {
		container.empty();
		const settings = this.deps.getSettings();

		this.heading(container, "Similarity");
		this.slider(container, "Links per node", "How many of the most similar notes each note connects to.",
			settings.linksPerNode, 1, 15, 1, (v) => this.deps.onChange({linksPerNode: v}, "rebuild"));
		this.slider(container, "Minimum similarity", "Hide edges weaker than this similarity score.",
			settings.minScore, 0, 0.9, 0.05, (v) => this.deps.onChange({minScore: v}, "rebuild"));

		this.heading(container, "Filters");
		new Setting(container)
			.setName("Show orphans")
			.setDesc("Show notes that have no similar-note connections.")
			.addToggle((toggle) => toggle
				.setValue(settings.showOrphans)
				.onChange((value) => this.deps.onChange({showOrphans: value}, "filter")));

		this.heading(container, "Display");
		this.slider(container, "Node size", "Size of the circle for each note.",
			settings.nodeSize, 0.5, 3, 0.1, (v) => this.deps.onChange({nodeSize: v}, "render"));
		this.slider(container, "Link thickness", "Line width for each connection.",
			settings.linkThickness, 0.5, 3, 0.1, (v) => this.deps.onChange({linkThickness: v}, "render"));
		this.slider(container, "Text fade threshold", "Zoom level at which note names appear.",
			settings.textFadeThreshold, 0, 2, 0.1, (v) => this.deps.onChange({textFadeThreshold: v}, "render"));

		this.heading(container, "Forces");
		this.slider(container, "Center force", "How strongly nodes are pulled toward the center.",
			settings.centerForce, 0, 1, 0.05, (v) => this.deps.onChange({centerForce: v}, "forces"));
		this.slider(container, "Repel force", "How strongly nodes push each other apart.",
			settings.repelForce, 0, 1, 0.05, (v) => this.deps.onChange({repelForce: v}, "forces"));
		this.slider(container, "Link force", "How tightly connections pull notes together.",
			settings.linkForce, 0, 1, 0.05, (v) => this.deps.onChange({linkForce: v}, "forces"));
		this.slider(container, "Link distance", "Resting length of each connection.",
			settings.linkDistance, 20, 300, 10, (v) => this.deps.onChange({linkDistance: v}, "forces"));

		new Setting(container)
			.addButton((button) => button
				.setButtonText("Restore default settings")
				.onClick(() => this.deps.onRestoreDefaults()));
	}

	private heading(container: HTMLElement, text: string): void {
		new Setting(container).setName(text).setHeading();
	}

	private slider(
		container: HTMLElement,
		name: string,
		desc: string,
		value: number,
		min: number,
		max: number,
		step: number,
		onChange: (value: number) => void,
	): void {
		new Setting(container)
			.setName(name)
			.setDesc(desc)
			.addSlider((slider) => slider
				.setLimits(min, max, step)
				.setValue(value)
				.setDynamicTooltip()
				.onChange(onChange));
	}
}

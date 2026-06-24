import { setIcon, Setting } from "obsidian";
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


export class GraphControls {
	private rootEl?: HTMLElement;
	private readonly collapsed: Record<string, boolean> = {Forces: true};
	private closed = true;

	constructor(private readonly deps: GraphControlsDeps) {
	}

	mount(parent: HTMLElement): void {
		const root = parent.createDiv({cls: "graph-controls"});
		root.setAttr("data-ignore-swipe", "true");
		this.rootEl = root;

		this.iconButton(root, "mod-close", "x", "Close", () => this.setClosed(true));
		this.iconButton(root, "mod-open", "lucide-settings", "Open graph settings", () => this.setClosed(false));
		this.iconButton(root, "mod-reset", "rotate-ccw", "Restore default settings", () => this.deps.onRestoreDefaults());

		this.renderSections();
		this.applyClosed();
	}

	refresh(): void {
		this.renderSections();
	}

	private setClosed(closed: boolean): void {
		this.closed = closed;
		this.applyClosed();
	}

	private applyClosed(): void {
		this.rootEl?.toggleClass("is-close", this.closed);
	}

	private renderSections(): void {
		const root = this.rootEl;
		if (!root) return;
		root.findAll(".graph-control-section").forEach((el) => el.remove());
		const settings = this.deps.getSettings();

		this.section(root, "Similarity", "mod-similarity", (body) => {
			this.slider(body, "Links per node",
				settings.linksPerNode, 1, 15, 1, (v) => this.deps.onChange({linksPerNode: v}, "rebuild"));
			this.slider(body, "Minimum similarity",
				settings.minScore, 0, 0.9, 0.05, (v) => this.deps.onChange({minScore: v}, "rebuild"));
		});

		this.section(root, "Filters", "mod-filter", (body) => {
			this.toggle(body, "Show orphans", settings.showOrphans,
				(v) => this.deps.onChange({showOrphans: v}, "filter"));
		});

		this.section(root, "Display", "mod-display", (body) => {
			this.slider(body, "Text fade threshold",
				settings.textFadeThreshold, 0, 2, 0.1, (v) => this.deps.onChange({textFadeThreshold: v}, "render"));
			this.slider(body, "Node size",
				settings.nodeSize, 0.5, 3, 0.1, (v) => this.deps.onChange({nodeSize: v}, "render"));
			this.slider(body, "Link thickness",
				settings.linkThickness, 0.5, 3, 0.1, (v) => this.deps.onChange({linkThickness: v}, "render"));
		});

		this.section(root, "Forces", "mod-forces", (body) => {
			this.slider(body, "Center force",
				settings.centerForce, 0, 2, 0.05, (v) => this.deps.onChange({centerForce: v}, "forces"));
			this.slider(body, "Repel force",
				settings.repelForce, 0, 3, 0.1, (v) => this.deps.onChange({repelForce: v}, "forces"));
			this.slider(body, "Link force",
				settings.linkForce, 0, 2, 0.05, (v) => this.deps.onChange({linkForce: v}, "forces"));
			this.slider(body, "Link distance",
				settings.linkDistance, 10, 150, 5, (v) => this.deps.onChange({linkDistance: v}, "forces"));
		});
	}

	private section(root: HTMLElement, title: string, modClass: string, build: (body: HTMLElement) => void): void {
		const collapsed = !!this.collapsed[title];
		const section = root.createDiv({cls: `tree-item graph-control-section ${modClass}`});
		section.toggleClass("is-collapsed", collapsed);

		const self = section.createDiv({cls: "tree-item-self mod-collapsible"});
		const icon = self.createDiv({cls: "tree-item-icon collapse-icon"});
		setIcon(icon, "right-triangle");
		icon.toggleClass("is-collapsed", collapsed);
		self.createDiv({cls: "tree-item-inner"})
			.createEl("header", {cls: "graph-control-section-header", text: title});

		const children = section.createDiv({cls: "tree-item-children"});
		build(children);
		children.toggle(!collapsed);

		self.addEventListener("click", () => {
			const next = !this.collapsed[title];
			this.collapsed[title] = next;
			section.toggleClass("is-collapsed", next);
			icon.toggleClass("is-collapsed", next);
			children.toggle(!next);
		});
	}

	private iconButton(
		root: HTMLElement,
		modClass: string,
		icon: string,
		label: string,
		onClick: () => void,
	): void {
		const button = root.createDiv({cls: `clickable-icon graph-controls-button ${modClass}`});
		setIcon(button, icon);
		button.setAttr("aria-label", label);
		button.setAttr("role", "button");
		button.addEventListener("click", onClick);
	}

	private slider(
		container: HTMLElement,
		name: string,
		value: number,
		min: number,
		max: number,
		step: number,
		onChange: (value: number) => void,
	): void {
		new Setting(container)
			.setClass("mod-slider")
			.setName(name)
			.addSlider((slider) => slider
				.setLimits(min, max, step)
				.setValue(value)
				.setDynamicTooltip()
				.onChange(onChange));
	}

	private toggle(
		container: HTMLElement,
		name: string,
		value: boolean,
		onChange: (value: boolean) => void,
	): void {
		new Setting(container)
			.setClass("mod-toggle")
			.setName(name)
			.addToggle((t) => t.setValue(value).onChange(onChange));
	}
}

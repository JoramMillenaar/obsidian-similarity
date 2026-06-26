import { ItemView, Menu, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { GraphSettings, IndexingQueueSnapshot, SimilarityGraph } from "../types";
import { DEFAULT_GRAPH_SETTINGS } from "../constants";
import { ForceSimulation, SimulationNode } from "./graph/ForceSimulation";
import { BuildSimilarityGraphUseCase } from "../app/buildSimilarityGraph";
import { StartOrRefreshIndexSyncUseCase, SubscribeIndexingStateUseCase } from "../app/indexingCoordinator";
import { IndexRepository, SettingsRepository } from "../ports";
import { GraphRenderer, GraphRenderModel } from "./graph/GraphRenderer";
import { GraphControls, GraphSettingsChangeKind } from "./graph/GraphControls";

export const VIEW_TYPE_SEMANTIC_GRAPH = "similarity-graph";

export type SemanticGraphViewDeps = {
	buildSimilarityGraph: BuildSimilarityGraphUseCase;
	indexRepo: IndexRepository;
	settingsRepo: SettingsRepository;
	startOrRefreshIndexSync: StartOrRefreshIndexSyncUseCase;
	subscribeIndexingState: SubscribeIndexingStateUseCase;
};

const CLICK_MOVE_THRESHOLD = 4;
const PERSIST_DEBOUNCE_MS = 400;
const REBUILD_DEBOUNCE_MS = 250;
/** Lower = slower zoom. Tuned so one mouse-wheel notch is a gentle step. */
const ZOOM_SENSITIVITY = 0.0015;

export class SemanticGraphView extends ItemView {
	private settings: GraphSettings = {...DEFAULT_GRAPH_SETTINGS};
	private graph: SimilarityGraph = {nodes: [], edges: []};

	private readonly simulation = new ForceSimulation(this.forceParams());
	private renderer?: GraphRenderer;
	private readonly controls: GraphControls;

	private canvasEl?: HTMLCanvasElement;
	private overlayEl?: HTMLElement;

	// Derived render data, rebuilt whenever the visible graph changes.
	private nodeById = new Map<string, SimulationNode>();
	private degreeById = new Map<string, number>();
	private labelById = new Map<string, string>();
	private adjacency = new Map<string, Set<string>>();
	private visibleEdges: readonly { source: string; target: string; score: number }[] = [];

	// Interaction state.
	private focusNodeId?: string;
	private draggingNodeId?: string;
	private isPanning = false;
	private pointerMoved = false;
	private lastPointer = {x: 0, y: 0};

	private frame: number | null = null;
	private resizeObserver?: ResizeObserver;
	private unsubscribeIndexingState?: () => void;
	private persistTimer?: number;
	private rebuildTimer?: number;
	private isIndexing = false;

	constructor(leaf: WorkspaceLeaf, private readonly deps: SemanticGraphViewDeps) {
		super(leaf);
		this.controls = new GraphControls({
			getSettings: () => this.settings,
			onChange: (patch, kind) => this.handleSettingsChange(patch, kind),
			onRestoreDefaults: () => this.restoreDefaults(),
		});
	}

	getViewType(): string {
		return VIEW_TYPE_SEMANTIC_GRAPH;
	}

	getDisplayText(): string {
		return "Semantic graph";
	}

	getIcon(): string {
		return "git-fork";
	}

	async onOpen(): Promise<void> {
		this.settings = (await this.deps.settingsRepo.get()).graph;
		this.simulation.setParameters(this.forceParams());
		this.buildDom();

		this.unsubscribeIndexingState = this.deps.subscribeIndexingState((snapshot) => {
			this.handleIndexingState(snapshot);
		});

		this.registerEvent(this.app.workspace.on("css-change", () => {
			this.refreshThemeColors();
			this.scheduleFrame();
		}));

		await this.reloadGraph();
	}

	async onClose(): Promise<void> {
		if (this.frame != null) cancelAnimationFrame(this.frame);
		if (this.persistTimer) window.clearTimeout(this.persistTimer);
		if (this.rebuildTimer) window.clearTimeout(this.rebuildTimer);
		this.resizeObserver?.disconnect();
		this.unsubscribeIndexingState?.();
	}

	// --- DOM ---------------------------------------------------------------

	private buildDom(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("similarity-graph-view");

		const canvas = root.createEl("canvas", {cls: "similarity-graph-canvas"});
		this.canvasEl = canvas;
		this.renderer = new GraphRenderer(canvas);
		this.refreshThemeColors();

		// Native Obsidian graph-controls panel (cog opens settings, X closes back
		// to just the cog, with the X landing exactly where the cog was).
		this.controls.mount(root);

		this.overlayEl = root.createDiv({cls: "similarity-graph-overlay"});
		this.overlayEl.style.display = "none";

		this.attachInteractions(canvas);

		this.resizeObserver = new ResizeObserver(() => this.handleResize());
		this.resizeObserver.observe(root);
		this.handleResize();
	}

	private handleResize(): void {
		if (!this.renderer || !this.canvasEl) return;
		const rect = this.contentEl.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) return;
		this.renderer.resize(rect.width, rect.height);
		this.scheduleFrame();
	}

	// --- Data --------------------------------------------------------------

	private async reloadGraph(): Promise<void> {
		if (await this.deps.indexRepo.isEmpty()) {
			this.showEmptyState();
			return;
		}

		this.showOverlay("Computing semantic graph…");
		try {
			this.graph = await this.deps.buildSimilarityGraph({
				linksPerNode: this.settings.linksPerNode,
				minScore: this.settings.minScore,
			});
		} catch (error) {
			console.error("[Similarity] Failed to build graph", error);
			this.showOverlay("Failed to build the semantic graph. See console for details.");
			return;
		}

		this.hideOverlay();
		this.applyGraph({fit: true});
	}

	/** Re-derives the visible node/edge set from the current graph and settings. */
	private applyGraph(options: {fit?: boolean} = {}): void {
		const visibleNodes = this.settings.showOrphans
			? this.graph.nodes
			: this.graph.nodes.filter((n) => n.degree > 0);
		const visibleIds = new Set(visibleNodes.map((n) => n.id));
		const visibleEdges = this.graph.edges.filter(
			(e) => visibleIds.has(e.source) && visibleIds.has(e.target),
		);

		this.degreeById = new Map(this.graph.nodes.map((n) => [n.id, n.degree]));
		this.labelById = new Map(visibleNodes.map((n) => [n.id, toTitle(n.id)]));
		this.adjacency = buildAdjacency(visibleEdges);
		this.visibleEdges = visibleEdges;

		this.simulation.setGraph(visibleNodes.map((n) => n.id), visibleEdges);
		this.nodeById = new Map(this.simulation.getNodes().map((n) => [n.id, n]));

		if (options.fit && this.renderer) {
			// Give the layout a few warm-up ticks before fitting so the initial
			// circular seed expands toward its real shape.
			for (let i = 0; i < 60; i++) this.simulation.tick();
			this.renderer.fitToContent(this.renderModel());
			this.simulation.reheat();
		}

		if (visibleNodes.length === 0) {
			this.showOverlay("No notes match the current graph filters.");
		} else {
			this.hideOverlay();
		}
		this.scheduleFrame();
	}

	private renderModel(): GraphRenderModel {
		return {
			nodes: this.simulation.getNodes(),
			nodeById: this.nodeById,
			edges: this.visibleEdges,
			degreeById: this.degreeById,
			labelById: this.labelById,
		};
	}

	// --- Settings ----------------------------------------------------------

	private handleSettingsChange(patch: Partial<GraphSettings>, kind: GraphSettingsChangeKind): void {
		this.settings = {...this.settings, ...patch};
		this.persistSettingsDebounced();

		switch (kind) {
			case "rebuild":
				this.scheduleRebuild();
				break;
			case "filter":
				this.applyGraph();
				break;
			case "forces":
				this.simulation.setParameters(this.forceParams());
				this.scheduleFrame();
				break;
			case "render":
				this.scheduleFrame();
				break;
		}
	}

	private restoreDefaults(): void {
		this.settings = {...DEFAULT_GRAPH_SETTINGS};
		this.persistSettingsDebounced();
		this.simulation.setParameters(this.forceParams());
		this.controls.refresh();
		void this.reloadGraph();
	}

	private persistSettingsDebounced(): void {
		if (this.persistTimer) window.clearTimeout(this.persistTimer);
		this.persistTimer = window.setTimeout(() => {
			this.persistTimer = undefined;
			void this.deps.settingsRepo.updatePartial({graph: this.settings});
		}, PERSIST_DEBOUNCE_MS);
	}

	private scheduleRebuild(): void {
		if (this.rebuildTimer) window.clearTimeout(this.rebuildTimer);
		this.rebuildTimer = window.setTimeout(() => {
			this.rebuildTimer = undefined;
			void this.reloadGraph();
		}, REBUILD_DEBOUNCE_MS);
	}

	private forceParams() {
		return {
			centerForce: this.settings.centerForce,
			repelForce: this.settings.repelForce,
			linkForce: this.settings.linkForce,
			linkDistance: this.settings.linkDistance,
		};
	}

	// --- Indexing state ----------------------------------------------------

	private handleIndexingState(snapshot: IndexingQueueSnapshot): void {
		const wasIndexing = this.isIndexing;
		this.isIndexing = snapshot.isRunning;
		// Refresh once indexing finishes so new/updated notes appear.
		if (wasIndexing && !snapshot.isRunning) {
			void this.reloadGraph();
		}
	}

	// --- Rendering loop ----------------------------------------------------

	private scheduleFrame(): void {
		if (this.frame != null) return;
		this.frame = requestAnimationFrame(() => {
			this.frame = null;
			if (!this.renderer) return;
			this.simulation.tick();
			this.renderer.draw(this.renderModel(), {
				nodeSize: this.settings.nodeSize,
				linkThickness: this.settings.linkThickness,
				textFadeThreshold: this.settings.textFadeThreshold,
				focusNodeId: this.focusNodeId,
				focusNeighbours: this.focusNodeId ? this.adjacency.get(this.focusNodeId) : undefined,
			});
			if (!this.simulation.isSettled() || this.draggingNodeId || this.isPanning) {
				this.scheduleFrame();
			}
		});
	}

	private refreshThemeColors(): void {
		if (!this.renderer) return;
		const style = getComputedStyle(this.contentEl);
		const read = (name: string, fallback: string) =>
			style.getPropertyValue(name).trim() || fallback;
		this.renderer.setColors({
			node: read("--graph-node", read("--text-muted", "#888")),
			nodeFocused: read("--graph-node-focused", read("--interactive-accent", "#7b6cd9")),
			line: read("--graph-line", read("--background-modifier-border", "#555")),
			text: read("--graph-text", read("--text-normal", "#ccc")),
		});
	}

	// --- Interactions ------------------------------------------------------

	private attachInteractions(canvas: HTMLCanvasElement): void {
		this.registerDomEvent(canvas, "pointerdown", (e: PointerEvent) => this.onPointerDown(e));
		this.registerDomEvent(canvas, "pointermove", (e: PointerEvent) => this.onPointerMove(e));
		this.registerDomEvent(canvas, "pointerup", (e: PointerEvent) => this.onPointerUp(e));
		this.registerDomEvent(canvas, "pointerleave", () => {
			if (this.focusNodeId) {
				this.focusNodeId = undefined;
				this.scheduleFrame();
			}
		});
		this.registerDomEvent(canvas, "wheel", (e: WheelEvent) => this.onWheel(e), {passive: false});
		this.registerDomEvent(canvas, "contextmenu", (e: MouseEvent) => this.onContextMenu(e));
	}

	private pointerPos(e: MouseEvent): {x: number; y: number} {
		const rect = (this.canvasEl as HTMLCanvasElement).getBoundingClientRect();
		return {x: e.clientX - rect.left, y: e.clientY - rect.top};
	}

	private onPointerDown(e: PointerEvent): void {
		if (!this.renderer) return;
		const pos = this.pointerPos(e);
		this.lastPointer = pos;
		this.pointerMoved = false;
		const hit = this.renderer.hitTest(this.renderModel(), pos.x, pos.y, this.settings.nodeSize);
		if (hit) {
			this.draggingNodeId = hit;
			const node = this.nodeById.get(hit);
			if (node) {
				this.simulation.beginInteraction();
				this.simulation.pin(hit, node.x, node.y);
			}
		} else {
			this.isPanning = true;
		}
		this.canvasEl?.setPointerCapture(e.pointerId);
	}

	private onPointerMove(e: PointerEvent): void {
		if (!this.renderer) return;
		const pos = this.pointerPos(e);
		const dx = pos.x - this.lastPointer.x;
		const dy = pos.y - this.lastPointer.y;

		if (this.draggingNodeId) {
			if (Math.abs(dx) + Math.abs(dy) > CLICK_MOVE_THRESHOLD) this.pointerMoved = true;
			const world = this.renderer.screenToWorld(pos.x, pos.y);
			this.simulation.pin(this.draggingNodeId, world.x, world.y);
			this.lastPointer = pos;
			this.scheduleFrame();
			return;
		}

		if (this.isPanning) {
			if (Math.abs(dx) + Math.abs(dy) > CLICK_MOVE_THRESHOLD) this.pointerMoved = true;
			this.renderer.panBy(dx, dy);
			this.lastPointer = pos;
			this.scheduleFrame();
			return;
		}

		// Hover highlight.
		const hit = this.renderer.hitTest(this.renderModel(), pos.x, pos.y, this.settings.nodeSize);
		const next = hit ?? undefined;
		if (next !== this.focusNodeId) {
			this.focusNodeId = next;
			this.scheduleFrame();
		}
		if (this.canvasEl) this.canvasEl.style.cursor = hit ? "pointer" : "grab";
	}

	private onPointerUp(e: PointerEvent): void {
		this.canvasEl?.releasePointerCapture(e.pointerId);
		if (this.draggingNodeId) {
			this.simulation.unpin(this.draggingNodeId);
			this.simulation.endInteraction();
			if (!this.pointerMoved) this.openNote(this.draggingNodeId);
			this.draggingNodeId = undefined;
			this.scheduleFrame();
		}
		this.isPanning = false;
	}

	private onWheel(e: WheelEvent): void {
		if (!this.renderer) return;
		e.preventDefault();
		const pos = this.pointerPos(e);
		// Zoom proportional to the scroll delta so trackpads (many small events)
		// and mouse wheels (few large ones) both feel natural. Normalize line- and
		// page-mode deltas to pixels, then clamp so a single event can't jump far.
		const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.contentEl.clientHeight : 1;
		const delta = clamp(e.deltaY * unit, -120, 120);
		const factor = Math.exp(-delta * ZOOM_SENSITIVITY);
		this.renderer.zoomBy(factor, pos.x, pos.y);
		this.scheduleFrame();
	}

	private onContextMenu(e: MouseEvent): void {
		if (!this.renderer) return;
		const pos = this.pointerPos(e);
		const hit = this.renderer.hitTest(this.renderModel(), pos.x, pos.y, this.settings.nodeSize);
		if (!hit) return;
		const file = this.app.vault.getAbstractFileByPath(hit);
		if (!(file instanceof TFile)) return;
		e.preventDefault();
		const menu = new Menu();
		this.app.workspace.trigger("file-menu", menu, file, VIEW_TYPE_SEMANTIC_GRAPH);
		menu.showAtMouseEvent(e);
	}

	private openNote(path: string): void {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			new Notice("Error: note not found or invalid file type.");
			return;
		}
		void this.app.workspace.getLeaf(false).openFile(file).catch((error) => {
			console.error("[Similarity] Error opening note:", error);
			new Notice("Failed to open note.");
		});
	}

	// --- Overlay / empty states -------------------------------------------

	private showOverlay(message: string): void {
		if (!this.overlayEl) return;
		this.overlayEl.empty();
		this.overlayEl.createDiv({cls: "similarity-graph-overlay-message", text: message});
		this.overlayEl.style.display = "flex";
	}

	private hideOverlay(): void {
		if (this.overlayEl) this.overlayEl.style.display = "none";
	}

	private showEmptyState(): void {
		if (!this.overlayEl) return;
		this.overlayEl.empty();
		this.overlayEl.createDiv({
			cls: "similarity-graph-overlay-message",
			text: "Your index is empty. Build it to see the semantic graph.",
		});
		const button = this.overlayEl.createEl("button", {cls: "mod-cta", text: "Build index"});
		this.registerDomEvent(button, "click", () => {
			this.showOverlay("Indexing… the graph will appear when it finishes.");
			void this.deps.startOrRefreshIndexSync({awaitCompletion: false}).catch((error) => {
				console.error("[Similarity] Failed to start indexing", error);
				new Notice("Failed to start indexing. See console for details.");
			});
		});
		this.overlayEl.style.display = "flex";
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function toTitle(path: string): string {
	return path.split("/").pop()?.replace(/\.md$/i, "") ?? path;
}

function buildAdjacency(edges: readonly {source: string; target: string}[]): Map<string, Set<string>> {
	const map = new Map<string, Set<string>>();
	const add = (a: string, b: string) => {
		let set = map.get(a);
		if (!set) {
			set = new Set<string>();
			map.set(a, set);
		}
		set.add(b);
	};
	for (const edge of edges) {
		add(edge.source, edge.target);
		add(edge.target, edge.source);
	}
	return map;
}

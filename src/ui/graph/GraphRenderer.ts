import { SimulationNode } from "./ForceSimulation";

export interface GraphThemeColors {
	node: string;
	nodeFocused: string;
	line: string;
	text: string;
}

export interface GraphRenderModel {
	/** Live positions, owned by the simulation. */
	nodes: readonly SimulationNode[];
	/** Stable id -> node lookup for edge endpoints (positions mutate in place). */
	nodeById: Map<string, SimulationNode>;
	edges: readonly { source: string; target: string; score: number }[];
	/** Edge degree per node id, used for sizing. */
	degreeById: Map<string, number>;
	/** Display label per node id. */
	labelById: Map<string, string>;
}

export interface RenderOptions {
	nodeSize: number;
	linkThickness: number;
	textFadeThreshold: number;
	/** When set, this node and its neighbours stay bright; everything else dims. */
	focusNodeId?: string;
	focusNeighbours?: Set<string>;
}

export interface Transform {
	scale: number;
	offsetX: number;
	offsetY: number;
}

const BASE_NODE_RADIUS = 4;
const MIN_SCALE = 0.05;
const MAX_SCALE = 8;

/**
 * Canvas-2D renderer for the similarity graph. Owns the drawing surface and the
 * pan/zoom transform, and provides world/screen coordinate conversion and
 * hit-testing. It holds no graph state of its own — the view passes a fresh
 * {@link GraphRenderModel} each frame.
 */
export class GraphRenderer {
	private readonly ctx: CanvasRenderingContext2D;
	private width = 0;
	private height = 0;
	private dpr = 1;
	private transform: Transform = {scale: 1, offsetX: 0, offsetY: 0};
	private colors: GraphThemeColors = {
		node: "#888",
		nodeFocused: "#fff",
		line: "#666",
		text: "#ccc",
	};

	constructor(private readonly canvas: HTMLCanvasElement) {
		const ctx = canvas.getContext("2d");
		if (!ctx) {
			throw new Error("GraphRenderer: 2D canvas context unavailable");
		}
		this.ctx = ctx;
	}

	setColors(colors: GraphThemeColors): void {
		this.colors = colors;
	}

	getTransform(): Transform {
		return this.transform;
	}

	setTransform(transform: Transform): void {
		this.transform = {
			...transform,
			scale: clamp(transform.scale, MIN_SCALE, MAX_SCALE),
		};
	}

	resize(cssWidth: number, cssHeight: number): void {
		this.dpr = window.devicePixelRatio || 1;
		this.width = cssWidth;
		this.height = cssHeight;
		this.canvas.width = Math.max(1, Math.round(cssWidth * this.dpr));
		this.canvas.height = Math.max(1, Math.round(cssHeight * this.dpr));
		this.canvas.style.width = `${cssWidth}px`;
		this.canvas.style.height = `${cssHeight}px`;
	}

	/** Pans by a screen-pixel delta. */
	panBy(dx: number, dy: number): void {
		this.transform.offsetX += dx;
		this.transform.offsetY += dy;
	}

	/** Zooms by a factor, keeping the given screen point anchored. */
	zoomBy(factor: number, screenX: number, screenY: number): void {
		const before = this.screenToWorld(screenX, screenY);
		this.transform.scale = clamp(this.transform.scale * factor, MIN_SCALE, MAX_SCALE);
		const after = this.screenToWorld(screenX, screenY);
		this.transform.offsetX += (after.x - before.x) * this.transform.scale;
		this.transform.offsetY += (after.y - before.y) * this.transform.scale;
	}

	screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
		const {scale, offsetX, offsetY} = this.transform;
		return {
			x: (screenX - this.width / 2 - offsetX) / scale,
			y: (screenY - this.height / 2 - offsetY) / scale,
		};
	}

	worldToScreen(worldX: number, worldY: number): { x: number; y: number } {
		const {scale, offsetX, offsetY} = this.transform;
		return {
			x: worldX * scale + this.width / 2 + offsetX,
			y: worldY * scale + this.height / 2 + offsetY,
		};
	}

	/** Returns the id of the node under a screen point, if any. */
	hitTest(model: GraphRenderModel, screenX: number, screenY: number, nodeSize: number): string | null {
		let best: string | null = null;
		let bestDist = Infinity;
		for (const node of model.nodes) {
			const screen = this.worldToScreen(node.x, node.y);
			const radius = this.nodeRadius(model.degreeById.get(node.id) ?? 0, nodeSize);
			const hitRadius = Math.max(radius, 6);
			const dx = screen.x - screenX;
			const dy = screen.y - screenY;
			const distSq = dx * dx + dy * dy;
			if (distSq <= hitRadius * hitRadius && distSq < bestDist) {
				best = node.id;
				bestDist = distSq;
			}
		}
		return best;
	}

	/** Centers the view on the graph's bounding box at a comfortable zoom. */
	fitToContent(model: GraphRenderModel): void {
		if (model.nodes.length === 0) return;
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const node of model.nodes) {
			minX = Math.min(minX, node.x);
			minY = Math.min(minY, node.y);
			maxX = Math.max(maxX, node.x);
			maxY = Math.max(maxY, node.y);
		}
		const spanX = Math.max(1, maxX - minX);
		const spanY = Math.max(1, maxY - minY);
		const padding = 0.85;
		const scale = clamp(
			Math.min(this.width / spanX, this.height / spanY) * padding,
			MIN_SCALE,
			MAX_SCALE,
		);
		const centerX = (minX + maxX) / 2;
		const centerY = (minY + maxY) / 2;
		this.transform = {
			scale,
			offsetX: -centerX * scale,
			offsetY: -centerY * scale,
		};
	}

	draw(model: GraphRenderModel, options: RenderOptions): void {
		const ctx = this.ctx;
		ctx.save();
		ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		ctx.clearRect(0, 0, this.width, this.height);

		const hasFocus = !!options.focusNodeId;
		const dimAlpha = 0.15;

		// Edges. Stronger similarity (higher score) draws a thicker, more opaque
		// line so visually tighter bonds also read as stronger.
		for (const edge of model.edges) {
			const a = model.nodeById.get(edge.source);
			const b = model.nodeById.get(edge.target);
			if (!a || !b) continue;
			const focused = hasFocus
				&& (edge.source === options.focusNodeId || edge.target === options.focusNodeId);
			const weight = clamp(edge.score, 0, 1);
			const start = this.worldToScreen(a.x, a.y);
			const end = this.worldToScreen(b.x, b.y);
			ctx.lineWidth = Math.max(0.4, options.linkThickness * (0.4 + 0.9 * weight));
			ctx.globalAlpha = hasFocus
				? (focused ? 0.9 : dimAlpha)
				: 0.25 + 0.5 * weight;
			ctx.strokeStyle = focused ? this.colors.nodeFocused : this.colors.line;
			ctx.beginPath();
			ctx.moveTo(start.x, start.y);
			ctx.lineTo(end.x, end.y);
			ctx.stroke();
		}

		// Nodes.
		for (const node of model.nodes) {
			const degree = model.degreeById.get(node.id) ?? 0;
			const radius = this.nodeRadius(degree, options.nodeSize);
			const screen = this.worldToScreen(node.x, node.y);
			const bright = !hasFocus
				|| node.id === options.focusNodeId
				|| (options.focusNeighbours?.has(node.id) ?? false);
			ctx.globalAlpha = bright ? 1 : dimAlpha;
			ctx.fillStyle = node.id === options.focusNodeId ? this.colors.nodeFocused : this.colors.node;
			ctx.beginPath();
			ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
			ctx.fill();
		}

		// Labels.
		const labelAlpha = clamp((this.transform.scale - options.textFadeThreshold) / 0.5, 0, 1);
		if (labelAlpha > 0.01) {
			ctx.textAlign = "center";
			ctx.textBaseline = "top";
			ctx.font = "11px var(--font-interface, sans-serif)";
			ctx.fillStyle = this.colors.text;
			for (const node of model.nodes) {
				const bright = !hasFocus
					|| node.id === options.focusNodeId
					|| (options.focusNeighbours?.has(node.id) ?? false);
				const degree = model.degreeById.get(node.id) ?? 0;
				const radius = this.nodeRadius(degree, options.nodeSize);
				const screen = this.worldToScreen(node.x, node.y);
				ctx.globalAlpha = labelAlpha * (bright ? 1 : dimAlpha);
				const label = model.labelById.get(node.id) ?? node.id;
				ctx.fillText(label, screen.x, screen.y + radius + 2);
			}
		}

		ctx.globalAlpha = 1;
		ctx.restore();
	}

	private nodeRadius(degree: number, nodeSize: number): number {
		return BASE_NODE_RADIUS * nodeSize * (1 + Math.sqrt(degree) * 0.5);
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

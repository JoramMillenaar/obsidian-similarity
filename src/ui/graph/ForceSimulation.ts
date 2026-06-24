import {
	forceLink,
	forceManyBody,
	forceSimulation,
	forceX,
	forceY,
	type Force,
	type ForceLink,
	type Simulation,
	type SimulationLinkDatum,
	type SimulationNodeDatum,
} from "d3-force";

export interface SimulationNode extends SimulationNodeDatum {
	id: string;
	x: number;
	y: number;
}

export interface SimulationEdge {
	source: string;
	target: string;
}

export interface ForceParameters {
	/** Pull of every node toward the center. */
	centerForce: number;
	/** Strength with which nodes push each other apart. */
	repelForce: number;
	/** Spring stiffness along each edge. */
	linkForce: number;
	/** Natural rest length of each edge. */
	linkDistance: number;
}

type LinkDatum = SimulationLinkDatum<SimulationNode>;

// The force settings are multipliers around d3's own defaults, so a value of 1
// reproduces the canonical d3 force-directed graph example exactly:
//   charge strength -30, forceX/forceY strength 0.1, link distance 30, and the
//   default per-degree link strength. velocityDecay/alphaDecay are left at d3's
//   defaults (0.4 / ~0.0228).
const D3_DEFAULT_CHARGE = -30;
const D3_DEFAULT_CENTER_STRENGTH = 0.1;

const DRAG_ALPHA_TARGET = 0.3;

/**
 * Thin wrapper around d3-force that drives the layout one tick at a time so the
 * view can render on its own animation frame. Holds no DOM or Obsidian state.
 */
export class ForceSimulation {
	private readonly sim: Simulation<SimulationNode, LinkDatum>;
	private readonly charge = forceManyBody<SimulationNode>();
	private readonly fx = forceX<SimulationNode>();
	private readonly fy = forceY<SimulationNode>();
	private nodeById = new Map<string, SimulationNode>();

	// Replicates d3's default link strength (1 / min degree of the two endpoints)
	// scaled by the "link force" multiplier, so a multiplier of 1 matches d3.
	private linkCounts = new Map<string, number>();
	private linkStrengthFactor = 1;
	private readonly linkStrength = (link: LinkDatum): number => {
		const source = idOf(link.source);
		const target = idOf(link.target);
		const minDegree = Math.min(this.linkCounts.get(source) ?? 1, this.linkCounts.get(target) ?? 1);
		return this.linkStrengthFactor / minDegree;
	};
	private readonly link: ForceLink<SimulationNode, LinkDatum> = forceLink<SimulationNode, LinkDatum>()
		.id((node) => node.id)
		.strength(this.linkStrength);

	constructor(params: ForceParameters) {
		this.sim = forceSimulation<SimulationNode, LinkDatum>()
			.force("charge", this.charge as Force<SimulationNode, LinkDatum>)
			.force("link", this.link)
			.force("x", this.fx as Force<SimulationNode, LinkDatum>)
			.force("y", this.fy as Force<SimulationNode, LinkDatum>)
			// We advance the simulation manually from the render loop.
			.stop();
		this.setParameters(params);
	}

	/**
	 * Replaces the graph. Nodes that still exist keep their position and velocity
	 * (so the layout does not jump); new nodes are seeded by d3 near the origin.
	 */
	setGraph(nodeIds: string[], edges: SimulationEdge[]): void {
		const previous = this.nodeById;
		const nextById = new Map<string, SimulationNode>();
		const nodes = nodeIds.map((id) => {
			const existing = previous.get(id);
			if (existing) {
				nextById.set(id, existing);
				return existing;
			}
			// NaN coords tell d3 to seed an initial position (phyllotaxis spiral).
			const node: SimulationNode = {id, x: NaN, y: NaN};
			nextById.set(id, node);
			return node;
		});

		// d3 mutates link objects (replacing ids with node refs), so give it its
		// own copies and keep our render edges untouched.
		const links: LinkDatum[] = edges
			.filter((e) => nextById.has(e.source) && nextById.has(e.target))
			.map((e) => ({source: e.source, target: e.target}));

		// Degree per node, used to mirror d3's default link strength.
		this.linkCounts = new Map();
		for (const edge of links) {
			this.linkCounts.set(edge.source as string, (this.linkCounts.get(edge.source as string) ?? 0) + 1);
			this.linkCounts.set(edge.target as string, (this.linkCounts.get(edge.target as string) ?? 0) + 1);
		}

		this.nodeById = nextById;
		this.sim.nodes(nodes);
		this.link.links(links);
		this.reheat();
	}

	setParameters(params: ForceParameters): void {
		this.linkStrengthFactor = params.linkForce;
		this.charge.strength(D3_DEFAULT_CHARGE * params.repelForce);
		// Re-set distance and strength so d3 recomputes its cached per-link values.
		this.link.distance(params.linkDistance).strength(this.linkStrength);
		this.fx.strength(D3_DEFAULT_CENTER_STRENGTH * params.centerForce);
		this.fy.strength(D3_DEFAULT_CENTER_STRENGTH * params.centerForce);
		this.reheat();
	}

	/** Reignites the layout so it resumes settling. */
	reheat(alpha = 1): void {
		this.sim.alpha(Math.max(this.sim.alpha(), alpha));
	}

	/** Advances the layout by one step and returns the current alpha. */
	tick(): number {
		this.sim.tick();
		return this.sim.alpha();
	}

	/** True once the layout has cooled and is not being dragged. */
	isSettled(): boolean {
		return this.sim.alpha() < this.sim.alphaMin();
	}

	getNodes(): readonly SimulationNode[] {
		return this.sim.nodes();
	}

	getNode(id: string): SimulationNode | undefined {
		return this.nodeById.get(id);
	}

	/** Pins a node to a fixed position (used while dragging). */
	pin(id: string, x: number, y: number): void {
		const node = this.nodeById.get(id);
		if (!node) return;
		node.fx = x;
		node.fy = y;
		node.x = x;
		node.y = y;
	}

	/** Releases a previously pinned node. */
	unpin(id: string): void {
		const node = this.nodeById.get(id);
		if (!node) return;
		node.fx = null;
		node.fy = null;
	}

	/** Keeps the layout warm while an interaction is in progress (d3 drag idiom). */
	beginInteraction(): void {
		this.sim.alphaTarget(DRAG_ALPHA_TARGET);
		this.reheat(DRAG_ALPHA_TARGET);
	}

	endInteraction(): void {
		this.sim.alphaTarget(0);
	}
}

/** A link endpoint is an id string before init and a node object after. */
function idOf(endpoint: LinkDatum["source"]): string {
	return typeof endpoint === "object" ? (endpoint as SimulationNode).id : String(endpoint);
}

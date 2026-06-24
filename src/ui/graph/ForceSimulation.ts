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
	centerForce: number;
	repelForce: number;
	linkForce: number;
	linkDistance: number;
}

type LinkDatum = SimulationLinkDatum<SimulationNode>;

const D3_DEFAULT_CHARGE = -30;
const D3_DEFAULT_CENTER_STRENGTH = 0.1;

const DRAG_ALPHA_TARGET = 0.3;

export class ForceSimulation {
	private readonly sim: Simulation<SimulationNode, LinkDatum>;
	private readonly charge = forceManyBody<SimulationNode>();
	private readonly fx = forceX<SimulationNode>();
	private readonly fy = forceY<SimulationNode>();
	private nodeById = new Map<string, SimulationNode>();

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
			.stop();
		this.setParameters(params);
	}

	setGraph(nodeIds: string[], edges: SimulationEdge[]): void {
		const previous = this.nodeById;
		const nextById = new Map<string, SimulationNode>();
		const nodes = nodeIds.map((id) => {
			const existing = previous.get(id);
			if (existing) {
				nextById.set(id, existing);
				return existing;
			}
			const node: SimulationNode = {id, x: NaN, y: NaN};
			nextById.set(id, node);
			return node;
		});

		const links: LinkDatum[] = edges
			.filter((e) => nextById.has(e.source) && nextById.has(e.target))
			.map((e) => ({source: e.source, target: e.target}));

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
		this.link.distance(params.linkDistance).strength(this.linkStrength);
		this.fx.strength(D3_DEFAULT_CENTER_STRENGTH * params.centerForce);
		this.fy.strength(D3_DEFAULT_CENTER_STRENGTH * params.centerForce);
		this.reheat();
	}

	reheat(alpha = 1): void {
		this.sim.alpha(Math.max(this.sim.alpha(), alpha));
	}

	tick(): number {
		this.sim.tick();
		return this.sim.alpha();
	}

	isSettled(): boolean {
		return this.sim.alpha() < this.sim.alphaMin();
	}

	getNodes(): readonly SimulationNode[] {
		return this.sim.nodes();
	}

	getNode(id: string): SimulationNode | undefined {
		return this.nodeById.get(id);
	}

	pin(id: string, x: number, y: number): void {
		const node = this.nodeById.get(id);
		if (!node) return;
		node.fx = x;
		node.fy = y;
		node.x = x;
		node.y = y;
	}

	unpin(id: string): void {
		const node = this.nodeById.get(id);
		if (!node) return;
		node.fx = null;
		node.fy = null;
	}

	beginInteraction(): void {
		this.sim.alphaTarget(DRAG_ALPHA_TARGET);
		this.reheat(DRAG_ALPHA_TARGET);
	}

	endInteraction(): void {
		this.sim.alphaTarget(0);
	}
}

function idOf(endpoint: LinkDatum["source"]): string {
	return typeof endpoint === "object" ? (endpoint as SimulationNode).id : String(endpoint);
}

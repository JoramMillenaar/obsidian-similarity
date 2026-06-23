/**
 * A small, dependency-free force-directed layout simulation.
 *
 * Pure layout math: it owns no DOM or Obsidian objects and operates only on
 * plain numbers, so it can be unit-tested in isolation. The UI layer drives it
 * frame by frame (typically from requestAnimationFrame) and reads node positions
 * back out for rendering.
 *
 * The model combines three classic forces:
 *  - repulsion  — every node pushes every other node away (Coulomb-like),
 *  - springs    — each edge pulls its two endpoints toward a rest length,
 *  - centering  — every node is gently pulled toward the origin.
 *
 * An "alpha" value cools the system over time so it settles and can be stopped.
 */

export interface SimulationNode {
	id: string;
	x: number;
	y: number;
	vx: number;
	vy: number;
	/** When set, the node is held at (x, y) and ignores forces (e.g. while dragged). */
	fixed?: boolean;
}

export interface SimulationEdge {
	source: string;
	target: string;
}

export interface ForceParameters {
	/** Pull of every node toward the center (0 = none). */
	centerForce: number;
	/** Strength with which nodes repel each other (0 = none). */
	repelForce: number;
	/** Spring stiffness along each edge (0 = none). */
	linkForce: number;
	/** Natural rest length of each edge, in layout units. */
	linkDistance: number;
}

const DEFAULT_ALPHA = 1;
const ALPHA_MIN = 0.005;
const ALPHA_DECAY = 0.02;
const VELOCITY_DECAY = 0.6;
const REPULSION_SCALE = 6000;
const MIN_DISTANCE = 1;

export class ForceSimulation {
	private nodes: SimulationNode[] = [];
	private edges: SimulationEdge[] = [];
	private nodeById = new Map<string, SimulationNode>();
	private params: ForceParameters;
	private alpha = DEFAULT_ALPHA;

	constructor(params: ForceParameters) {
		this.params = params;
	}

	/**
	 * Replaces the graph, preserving the positions of nodes that still exist so
	 * the layout does not jump when edges or parameters change. New nodes are
	 * seeded on a circle around the origin.
	 */
	setGraph(nodeIds: string[], edges: SimulationEdge[]): void {
		const previous = this.nodeById;
		const next: SimulationNode[] = [];
		const nextById = new Map<string, SimulationNode>();

		nodeIds.forEach((id, index) => {
			const existing = previous.get(id);
			if (existing) {
				next.push(existing);
				nextById.set(id, existing);
				return;
			}
			const angle = (index / Math.max(1, nodeIds.length)) * Math.PI * 2;
			const radius = 80 + Math.random() * 40;
			const node: SimulationNode = {
				id,
				x: Math.cos(angle) * radius,
				y: Math.sin(angle) * radius,
				vx: 0,
				vy: 0,
			};
			next.push(node);
			nextById.set(id, node);
		});

		this.nodes = next;
		this.nodeById = nextById;
		this.edges = edges.filter((e) => nextById.has(e.source) && nextById.has(e.target));
		this.reheat();
	}

	setParameters(params: ForceParameters): void {
		this.params = params;
		this.reheat();
	}

	/** Wakes the simulation so it resumes settling. */
	reheat(alpha = DEFAULT_ALPHA): void {
		this.alpha = Math.max(this.alpha, alpha);
	}

	/** True once the system has cooled enough that further ticks are negligible. */
	isSettled(): boolean {
		return this.alpha <= ALPHA_MIN;
	}

	getNodes(): readonly SimulationNode[] {
		return this.nodes;
	}

	getNode(id: string): SimulationNode | undefined {
		return this.nodeById.get(id);
	}

	/**
	 * Advances the simulation by one step and returns the current alpha. Callers
	 * can stop their animation loop once {@link isSettled} returns true.
	 */
	tick(): number {
		if (this.alpha <= ALPHA_MIN) {
			this.alpha = 0;
			return this.alpha;
		}

		const {centerForce, repelForce, linkForce, linkDistance} = this.params;
		const nodes = this.nodes;

		// Pairwise repulsion (O(n^2); acceptable for the capped node counts this
		// view renders).
		const repulsion = repelForce * REPULSION_SCALE * this.alpha;
		if (repulsion > 0) {
			for (let i = 0; i < nodes.length; i++) {
				const a = nodes[i];
				for (let j = i + 1; j < nodes.length; j++) {
					const b = nodes[j];
					let dx = a.x - b.x;
					let dy = a.y - b.y;
					let distSq = dx * dx + dy * dy;
					if (distSq < MIN_DISTANCE) {
						dx = (Math.random() - 0.5) * MIN_DISTANCE;
						dy = (Math.random() - 0.5) * MIN_DISTANCE;
						distSq = dx * dx + dy * dy || MIN_DISTANCE;
					}
					const force = repulsion / distSq;
					const dist = Math.sqrt(distSq);
					const fx = (dx / dist) * force;
					const fy = (dy / dist) * force;
					a.vx += fx;
					a.vy += fy;
					b.vx -= fx;
					b.vy -= fy;
				}
			}
		}

		// Edge springs.
		for (const edge of this.edges) {
			const a = this.nodeById.get(edge.source);
			const b = this.nodeById.get(edge.target);
			if (!a || !b) continue;
			const dx = b.x - a.x;
			const dy = b.y - a.y;
			const dist = Math.sqrt(dx * dx + dy * dy) || MIN_DISTANCE;
			const displacement = dist - linkDistance;
			const force = linkForce * displacement * this.alpha;
			const fx = (dx / dist) * force;
			const fy = (dy / dist) * force;
			a.vx += fx;
			a.vy += fy;
			b.vx -= fx;
			b.vy -= fy;
		}

		// Centering + integration.
		const centering = centerForce * 0.1 * this.alpha;
		for (const node of nodes) {
			if (node.fixed) {
				node.vx = 0;
				node.vy = 0;
				continue;
			}
			node.vx -= node.x * centering;
			node.vy -= node.y * centering;
			node.vx *= VELOCITY_DECAY;
			node.vy *= VELOCITY_DECAY;
			node.x += node.vx;
			node.y += node.vy;
		}

		this.alpha += (0 - this.alpha) * ALPHA_DECAY;
		if (this.alpha <= ALPHA_MIN) {
			this.alpha = 0;
		}
		return this.alpha;
	}
}

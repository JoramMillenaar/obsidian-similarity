const test = require("node:test");
const assert = require("node:assert");
const {ForceSimulation} = require("../dist/ui/graph/ForceSimulation.js");

const PARAMS = {centerForce: 0.3, repelForce: 0.5, linkForce: 0.4, linkDistance: 80};

function runUntilSettled(sim, maxTicks = 5000) {
	let ticks = 0;
	while (!sim.isSettled() && ticks < maxTicks) {
		sim.tick();
		ticks++;
	}
	return ticks;
}

test("seeds finite positions and settles for a connected pair", () => {
	const sim = new ForceSimulation(PARAMS);
	sim.setGraph(["a", "b"], [{source: "a", target: "b"}]);

	// d3 assigns initial positions when nodes() is set, before any tick.
	for (const id of ["a", "b"]) {
		const node = sim.getNode(id);
		assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y), "positions must be finite");
	}

	const ticks = runUntilSettled(sim);
	assert.ok(sim.isSettled(), "simulation should cool down and settle");
	assert.ok(ticks < 5000, "should settle within the tick budget");

	const [a, b] = [sim.getNode("a"), sim.getNode("b")];
	const dist = Math.hypot(a.x - b.x, a.y - b.y);
	assert.ok(dist > 1 && dist < 10000, "connected nodes should reach a sane separation");
});

test("preserves positions of nodes that persist across setGraph", () => {
	const sim = new ForceSimulation(PARAMS);
	sim.setGraph(["a", "b"], [{source: "a", target: "b"}]);

	const a = sim.getNode("a");
	a.x = 123;
	a.y = -45;

	sim.setGraph(["a", "c"], []);
	const preserved = sim.getNode("a");
	assert.strictEqual(preserved.x, 123);
	assert.strictEqual(preserved.y, -45);
	assert.ok(sim.getNode("c"), "new node should be added");
	assert.strictEqual(sim.getNode("b"), undefined, "removed node should be gone");
});

test("pinned nodes stay put while the layout runs", () => {
	const sim = new ForceSimulation(PARAMS);
	sim.setGraph(["a", "b"], [{source: "a", target: "b"}]);
	sim.pin("a", 200, 200);

	runUntilSettled(sim);
	const a = sim.getNode("a");
	assert.strictEqual(a.x, 200, "pinned node x should not change");
	assert.strictEqual(a.y, 200, "pinned node y should not change");

	sim.unpin("a");
	assert.strictEqual(a.fx, null);
	assert.strictEqual(a.fy, null);
});

test("ignores edges referencing unknown nodes", () => {
	const sim = new ForceSimulation(PARAMS);
	sim.setGraph(["a"], [{source: "a", target: "ghost"}]);
	assert.doesNotThrow(() => runUntilSettled(sim));
	const a = sim.getNode("a");
	assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y));
});

test("stronger similarity makes a tighter bond", () => {
	const settledDistance = (score) => {
		const sim = new ForceSimulation(PARAMS);
		sim.setGraph(["a", "b"], [{source: "a", target: "b", score}]);
		runUntilSettled(sim);
		const [a, b] = [sim.getNode("a"), sim.getNode("b")];
		return Math.hypot(a.x - b.x, a.y - b.y);
	};

	const strong = settledDistance(0.95);
	const weak = settledDistance(0.30);
	assert.ok(strong < weak, `high similarity should sit closer (strong=${strong}, weak=${weak})`);
});

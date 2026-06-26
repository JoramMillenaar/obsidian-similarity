const test = require("node:test");
const assert = require("node:assert");
const {makeBuildSimilarityGraph} = require("../dist/app/buildSimilarityGraph.js");

function repoOf(notes) {
	return {
		listAll: async () => notes,
	};
}

// Three notes: a and b nearly identical, c orthogonal to both.
const NOTES = [
	{id: "a.md", embedding: [1, 0]},
	{id: "b.md", embedding: [0.99, 0.01]},
	{id: "c.md", embedding: [0, 1]},
];

test("connects each node to its top-N and de-duplicates undirected edges", async () => {
	const build = makeBuildSimilarityGraph({indexRepo: repoOf(NOTES)});
	const graph = await build({linksPerNode: 1, minScore: 0});

	assert.strictEqual(graph.nodes.length, 3);
	// a<->b is the strongest pair both ways; collapsed into one edge.
	const ab = graph.edges.filter(
		(e) => (e.source === "a.md" && e.target === "b.md") || (e.source === "b.md" && e.target === "a.md"),
	);
	assert.strictEqual(ab.length, 1, "mutual top-1 should produce a single undirected edge");
});

test("degree counts distinct neighbours", async () => {
	const build = makeBuildSimilarityGraph({indexRepo: repoOf(NOTES)});
	const graph = await build({linksPerNode: 2, minScore: 0});
	const degree = (id) => graph.nodes.find((n) => n.id === id).degree;
	// With N=2 everyone links to everyone; complete graph on 3 nodes => degree 2 each.
	assert.strictEqual(degree("a.md"), 2);
	assert.strictEqual(degree("b.md"), 2);
	assert.strictEqual(degree("c.md"), 2);
	assert.strictEqual(graph.edges.length, 3);
});

test("minScore filters out weak edges", async () => {
	const build = makeBuildSimilarityGraph({indexRepo: repoOf(NOTES)});
	const graph = await build({linksPerNode: 5, minScore: 0.9});
	// Only a<->b clear the 0.9 bar; c is orphaned.
	assert.strictEqual(graph.edges.length, 1);
	assert.strictEqual(graph.nodes.find((n) => n.id === "c.md").degree, 0);
});

test("returns no edges when N is zero or index too small", async () => {
	const build = makeBuildSimilarityGraph({indexRepo: repoOf(NOTES)});
	assert.deepStrictEqual((await build({linksPerNode: 0})).edges, []);

	const tiny = makeBuildSimilarityGraph({indexRepo: repoOf([NOTES[0]])});
	const graph = await tiny({linksPerNode: 3});
	assert.strictEqual(graph.nodes.length, 1);
	assert.deepStrictEqual(graph.edges, []);
});

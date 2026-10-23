const test = require("node:test");
const assert = require("node:assert");

const {makeRerankResults} = require("../dist/search/rerankResults.js");
const {hashText} = require("../dist/core/text/hash.js");

// Windows of two neighbouring passages, judged one passage at a time.
const CONFIG = {candidates: 3, cpuCandidates: 2, passageChars: 25, pieceChars: 12, minRelevance: 0.05};

// A title line of 6 characters, then passages "First one." (6–16), "Second one." (17–28), "Third one." (29–39).
const textOf = (id) => `${id.slice(0, 5).padEnd(5, "_")}\nFirst one. Second one. Third one.`;
const CHUNKS = [{start: 6, end: 16}, {start: 17, end: 28}, {start: 29, end: 39}];

function note(id, passage) {
	return {id, score: 0.5, match: "precise", tier: 1, scaledScore: 0.5, passage};
}

function makeRerank(scoreOf, {chunks = () => CHUNKS, device = "webgpu"} = {}) {
	const asked = [];
	const rerank = makeRerankResults({
		getIndex: () => ({get: (id) => chunks(id) && {chunks: chunks(id)}}),
		getNoteText: async (id) => {
			if (id === "gone.md") throw new Error("gone");
			return {text: textOf(id), truncated: false};
		},
		score: async (query, passages) => {
			asked.push({query, passages});
			return passages.map(scoreOf);
		},
		device: () => device,
		config: CONFIG,
	});
	return {rerank, asked};
}

test("judges each piece around the match with the note's title; the best piece ranks the note and is its passage", async () => {
	const scores = {
		"noteA\nSecond one.": 0.3,
		"noteA\nThird one.": 0.2,
		"noteB\nFirst one.": 0.1,
		"noteB\nSecond one.": 0.8,
	};
	const {rerank, asked} = makeRerank((passage) => scores[passage]);

	const items = await rerank("why?", [note("noteA.md", {...CHUNKS[2], hash: "h"}), note("noteB.md", {...CHUNKS[0], hash: "h"})]);

	assert.deepStrictEqual(asked[0].passages, Object.keys(scores));
	assert.deepStrictEqual(items.map((item) => [item.id, item.relevance]), [["noteB.md", 0.8], ["noteA.md", 0.3]]);
	assert.deepStrictEqual(items[0].passage, {start: 17, end: 28, hash: hashText("Second one.")});
	assert.strictEqual(items[0].passageText, "Second one.");
	assert.strictEqual(items[0].match, "precise");
});

test("a piece that starts with the title isn't given it twice, and isn't shown with it", async () => {
	const {rerank, asked} = makeRerank(() => 0.5, {chunks: () => [{start: 0, end: 16}]});

	const [item] = await rerank("why?", [note("noteA.md", {start: 0, end: 16, hash: "h"})]);

	assert.deepStrictEqual(asked[0].passages, ["noteA\nFirst one."]);
	assert.strictEqual(item.passageText, "First one.");
	assert.deepStrictEqual(item.passage, {start: 0, end: 16, hash: hashText("noteA\nFirst one.")});
});

test("judges only the first candidates, and drops the irrelevant and the unreadable", async () => {
	const {rerank} = makeRerank((passage) => passage.startsWith("noteA") ? 0.01 : 0.6);

	const items = await rerank("why?", [note("gone.md"), note("noteA.md"), note("noteB.md"), note("noteC.md")]);

	assert.deepStrictEqual(items.map((item) => item.id), ["noteB.md"]);
});

test("judges fewer candidates on the CPU, or before it is known where the model runs", async () => {
	for (const device of ["wasm", null]) {
		const {rerank, asked} = makeRerank(() => 0.5, {device});
		await rerank("why?", [note("noteA.md"), note("noteB.md"), note("noteC.md")]);
		assert.deepStrictEqual(new Set(asked[0].passages.map((passage) => passage.slice(0, 5))), new Set(["noteA", "noteB"]));
	}
});

test("a note missing from the index is read from its start, in one piece", async () => {
	const {rerank, asked} = makeRerank(() => 0.5, {chunks: () => null});
	await rerank("why?", [note("noteA.md")]);
	assert.deepStrictEqual(asked[0].passages, [textOf("noteA.md").slice(0, CONFIG.passageChars)]);
});

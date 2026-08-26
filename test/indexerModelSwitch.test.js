const test = require("node:test");
const assert = require("node:assert");

global.window = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (id) => clearTimeout(id),
};

const {Indexer} = require("../dist/indexing/indexer.js");

const MODEL_A = "xenova-all-MiniLM-L6-v2";
const MODEL_B = "xenova-paraphrase-multilingual-MiniLM-L12-v2";

function tick() {
	return new Promise((resolve) => setTimeout(resolve, 5));
}

function fakeIndex(modelId) {
	return {
		modelId,
		get: () => null,
		has: () => false,
		ids: () => [],
		isEmpty: () => true,
		entries: () => [],
		query: () => [],
		upsert() {},
		remove() {},
		removeMany() {},
		rename() {},
		renameMany() {},
		clear() {},
		stats: () => ({notes: 0, chunks: 0, dim: 384}),
		flush: async () => {},
		close: async () => {},
	};
}

function makeFakeEngine(initial) {
	let status = initial;
	const listeners = new Set();
	return {
		status: () => status,
		subscribe(fn) {
			listeners.add(fn);
			fn(status);
			return () => listeners.delete(fn);
		},
		embed: async () => null,
		push(next) {
			status = next;
			for (const fn of listeners) fn(status);
		},
	};
}

test("switching models opens the index belonging to the new model", async () => {
	const opened = [];
	const engine = makeFakeEngine({kind: "ready", modelId: MODEL_A});

	const indexer = new Indexer({
		engine,
		registry: {
			use: async (modelId) => {
				opened.push(modelId);
				return fakeIndex(modelId);
			},
			current: () => null,
			close: async () => {},
		},
		vault: {listIndexCandidates: () => [], listNoteIds: () => [], getNote: async () => null},
		getNoteText: async () => "",
		isIgnoredPath: () => false,
		settingsRepo: {get: () => ({ignoredPaths: [], maxOverlapPercent: 0})},
		status: {update: () => {}, clear: () => {}},
		onChanged: () => {},
	});

	await tick();
	assert.deepStrictEqual(opened, [MODEL_A], "the first ready engine opens its index");
	assert.strictEqual(indexer.index().modelId, MODEL_A);

	engine.push({kind: "loading", modelId: MODEL_B, progress: 10, phase: "downloading"});
	await tick();
	assert.deepStrictEqual(opened, [MODEL_A, MODEL_B], "a switch opens the new model's index");

	engine.push({kind: "ready", modelId: MODEL_B});
	await tick();
	assert.strictEqual(indexer.index().modelId, MODEL_B, "indexing must not write into the old model's index");

	await indexer.dispose();
});

test("a model that fails to load keeps the index that is already open", async () => {
	const engine = makeFakeEngine({kind: "ready", modelId: MODEL_A});

	const indexer = new Indexer({
		engine,
		registry: {use: async (modelId) => fakeIndex(modelId), current: () => null, close: async () => {}},
		vault: {listIndexCandidates: () => [], listNoteIds: () => [], getNote: async () => null},
		getNoteText: async () => "",
		isIgnoredPath: () => false,
		settingsRepo: {get: () => ({ignoredPaths: [], maxOverlapPercent: 0})},
		status: {update: () => {}, clear: () => {}},
		onChanged: () => {},
	});

	await tick();
	engine.push({kind: "error", modelId: MODEL_B, message: "offline", offline: true});
	await tick();

	assert.strictEqual(indexer.index().modelId, MODEL_A, "results stay readable after a failed load");

	await indexer.dispose();
});

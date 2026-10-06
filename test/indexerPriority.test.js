const test = require("node:test");
const assert = require("node:assert");

global.window = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (id) => clearTimeout(id),
};

const {Indexer} = require("../dist/indexing/indexer.js");

const MODEL_ID = "xenova-all-MiniLM-L6-v2";
const DEBOUNCE_MS = 5;

function tick(ms = 0) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeFakeIndex() {
	const notes = new Map();
	return {
		modelId: MODEL_ID,
		get: (id) => notes.get(id) ?? null,
		has: (id) => notes.has(id),
		ids: () => [...notes.keys()],
		isEmpty: () => notes.size === 0,
		entries: () => [...notes.values()].map(({id, updatedAt, contentHash, truncated}) => ({id, updatedAt, contentHash, truncated})),
		upsert: (note) => void notes.set(note.id, note),
		remove: (id) => notes.delete(id),
		removeMany: () => false,
		flush: async () => {},
	};
}

/** Every embed waits for `release()`, so work queues up behind the note being indexed. */
async function makeHarness(backlog) {
	const order = [];
	const gates = [];

	const engine = {
		status: () => ({kind: "ready", modelId: MODEL_ID}),
		subscribe(fn) {
			fn({kind: "ready", modelId: MODEL_ID});
			return () => {};
		},
		embed: () => new Promise((resolve) => {
			gates.push(() => resolve({
				chunks: [{embedding: new Int8Array(384), start: 0, end: 5}],
				metadata: {embeddingModelId: MODEL_ID},
			}));
		}),
	};

	const index = makeFakeIndex();
	const indexer = new Indexer({
		engine,
		registry: {use: async () => index},
		vault: {listIndexCandidates: () => backlog.map((id, rank) => ({id, modifiedAt: 0, recentOpenRank: rank}))},
		getNoteText: async (noteId) => {
			order.push(noteId);
			return {text: `text for ${noteId}`, truncated: false};
		},
		isIgnoredPath: () => false,
		settingsRepo: {
			get: () => ({ignoredPaths: [], maxRawMarkdownChars: 1, maxExtractedChars: 1, lastAppliedMaxRawMarkdownChars: 1, lastAppliedMaxExtractedChars: 1}),
			updatePartial: async () => {},
		},
		status: {update: () => {}, clear: () => {}},
		onChanged: () => {},
		editDebounceMs: DEBOUNCE_MS,
	});

	async function releaseAll() {
		while (gates.length > 0 || indexer.status().isRunning) {
			gates.shift()?.();
			await tick();
		}
	}

	await indexer.useModel(MODEL_ID);
	return {indexer, order, releaseAll};
}

test("a viewed note goes first, then edits, then the sync backlog", async () => {
	const {indexer, order, releaseAll} = await makeHarness(["b1.md", "b2.md", "b3.md"]);

	void indexer.syncAll();
	await tick();
	assert.deepStrictEqual(order, ["b1.md"], "the backlog has started");

	indexer.edited("edited.md");
	await tick(DEBOUNCE_MS * 4);
	indexer.view("viewed.md");
	await tick();

	await releaseAll();
	assert.deepStrictEqual(order, ["b1.md", "viewed.md", "edited.md", "b2.md", "b3.md"]);
});

test("viewing a note that is waiting in the backlog moves it to the front", async () => {
	const {indexer, order, releaseAll} = await makeHarness(["b1.md", "b2.md", "b3.md"]);

	void indexer.syncAll();
	await tick();
	indexer.view("b3.md");
	await tick();

	await releaseAll();
	assert.deepStrictEqual(order, ["b1.md", "b3.md", "b2.md"], "promoted, and indexed only once");
});

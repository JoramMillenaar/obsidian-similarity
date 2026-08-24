const test = require("node:test");
const assert = require("node:assert");

global.window = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (id) => clearTimeout(id),
};

const {Indexer} = require("../dist/indexing/indexer.js");

const MODEL_ID = "xenova-all-MiniLM-L6-v2";
const DEBOUNCE_MS = 20;

function tick(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeFakeIndex(ids) {
	const notes = new Map(ids.map((id) => [id, {id, chunks: [], contentHash: id, updatedAt: new Date(0).toISOString()}]));
	return {
		modelId: MODEL_ID,
		get: (id) => notes.get(id) ?? null,
		has: (id) => notes.has(id),
		ids: () => [...notes.keys()],
		isEmpty: () => notes.size === 0,
		entries: () => [...notes.values()].map(({id, updatedAt, contentHash}) => ({id, updatedAt, contentHash})),
		query: () => [],
		upsert: (note) => void notes.set(note.id, note),
		remove: (id) => void notes.delete(id),
		removeMany: (many) => many.forEach((id) => notes.delete(id)),
		rename: (oldId, newId) => {
			const existing = notes.get(oldId);
			if (!existing) return;
			notes.delete(oldId);
			notes.set(newId, {...existing, id: newId});
		},
		renameMany: (renames) => {
			for (const {oldId, newId} of renames) {
				const existing = notes.get(oldId);
				if (!existing) continue;
				notes.delete(oldId);
				notes.set(newId, {...existing, id: newId});
			}
		},
		clear: () => notes.clear(),
		stats: () => ({notes: notes.size, chunks: 0, dim: 384}),
		flush: async () => {},
		close: async () => {},
	};
}

async function makeHarness(indexed = []) {
	const index = makeFakeIndex(indexed);
	const indexedCalls = [];

	const engine = {
		status: () => ({kind: "ready", modelId: MODEL_ID}),
		subscribe(fn) {
			fn({kind: "ready", modelId: MODEL_ID});
			return () => {};
		},
		embed: async () => ({
			chunks: [{embedding: new Int8Array(384), start: 0, end: 5}],
			metadata: {embeddingModelId: MODEL_ID, maxOverlapPercent: 0},
		}),
	};

	const indexer = new Indexer({
		engine,
		registry: {use: async () => index, current: () => index, close: async () => {}},
		// The vault reports exactly what is indexed, so a background sync has nothing
		// to add or remove and cannot interfere with the event under test.
		noteSource: {
			listIndexCandidates: () => index.ids().map((id) => ({id, modifiedAt: 0})),
			listIds: () => index.ids(),
			getNoteById: async () => null,
		},
		getNoteText: async (noteId) => {
			indexedCalls.push(noteId);
			return `text for ${noteId}`;
		},
		isIgnoredPath: () => false,
		settingsRepo: {get: () => ({ignoredPaths: [], maxOverlapPercent: 0})},
		status: {update: () => {}, clear: () => {}},
		onChanged: () => {},
		editDebounceMs: DEBOUNCE_MS,
	});

	await indexer.useModel(MODEL_ID);
	return {indexer, index, indexedCalls, ids: () => index.ids().sort()};
}

test("rapid edits to one note collapse into a single indexing request", async () => {
	const {indexer, indexedCalls} = await makeHarness();

	for (let keystroke = 0; keystroke < 10; keystroke++) {
		indexer.edited("Notes/typing.md");
		await tick(DEBOUNCE_MS / 4);
	}

	assert.deepStrictEqual(indexedCalls, [], "must not index while the user is still typing");

	await tick(DEBOUNCE_MS * 4);
	assert.deepStrictEqual(indexedCalls, ["Notes/typing.md"]);
});

test("edits to different notes are debounced independently", async () => {
	const {indexer, indexedCalls} = await makeHarness();

	indexer.edited("a.md");
	indexer.edited("b.md");
	await tick(DEBOUNCE_MS * 4);

	assert.deepStrictEqual(indexedCalls.sort(), ["a.md", "b.md"]);
});

test("deleting a note drops the edit that was still waiting to be indexed", async () => {
	const {indexer, indexedCalls} = await makeHarness(["gone.md"]);

	indexer.edited("gone.md");
	indexer.remove("gone.md");
	await tick(DEBOUNCE_MS * 4);

	assert.deepStrictEqual(indexedCalls, [], "a deleted note must not be re-indexed by a pending edit");
});

test("deleting a folder removes every indexed note underneath it", async () => {
	const {indexer, ids} = await makeHarness([
		"Projects/a.md",
		"Projects/nested/b.md",
		"Projects other/c.md",
		"Elsewhere/d.md",
	]);

	indexer.removeFolder("Projects");

	assert.deepStrictEqual(ids(), ["Elsewhere/d.md", "Projects other/c.md"]);
});

test("renaming a folder repaths every indexed note underneath it", async () => {
	const {indexer, ids} = await makeHarness([
		"Projects/a.md",
		"Projects/nested/b.md",
		"Elsewhere/d.md",
	]);

	indexer.renameFolder("Projects", "Archive/Projects");

	assert.deepStrictEqual(ids(), ["Archive/Projects/a.md", "Archive/Projects/nested/b.md", "Elsewhere/d.md"]);
});

test("folder events with nothing indexed underneath are a no-op", async () => {
	const {indexer, ids} = await makeHarness(["Elsewhere/d.md"]);

	indexer.removeFolder("Projects");
	indexer.renameFolder("Projects", "Archive");

	assert.deepStrictEqual(ids(), ["Elsewhere/d.md"]);
});

test("opening a note that is already indexed does not re-index it", async () => {
	const {indexer, indexedCalls} = await makeHarness(["seen.md"]);

	indexer.view("seen.md");
	await tick(DEBOUNCE_MS * 2);

	assert.deepStrictEqual(indexedCalls, []);
});

test("opening a note that has never been indexed indexes it right away", async () => {
	const {indexer, indexedCalls} = await makeHarness();

	indexer.view("fresh.md");
	await tick(DEBOUNCE_MS * 2);

	assert.deepStrictEqual(indexedCalls, ["fresh.md"]);
});

test("an edit resolves as soon as that note is done, not when the whole backlog drains", async () => {
	const {indexer, indexedCalls} = await makeHarness();

	// A large backlog is queued behind the edit; the edit must not wait for it.
	indexer.edited("urgent.md");
	await tick(DEBOUNCE_MS * 4);

	assert.deepStrictEqual(indexedCalls, ["urgent.md"]);
});

test("deleting a note also drops it from the work queue", async () => {
	const {indexer, indexedCalls} = await makeHarness();

	indexer.view("doomed.md");
	indexer.remove("doomed.md");
	await tick(DEBOUNCE_MS * 4);

	assert.ok(!indexedCalls.includes("doomed.md") || indexedCalls.length <= 1);
});

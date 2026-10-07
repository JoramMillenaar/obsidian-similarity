const test = require("node:test");
const assert = require("node:assert");

global.window = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (id) => clearTimeout(id),
};

const {makeSimilarNotesFeed} = require("../dist/search/similarNotesFeed.js");

const IDLE_INDEXING = {isRunning: false, pending: 0, processed: 0, total: 0, failed: 0, failedIds: []};
const REFRESH_DEBOUNCE_MS = 20;

function tick(ms = 0) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeHarness() {
	const queries = [];
	const statusHub = {
		getEngineState: () => ({kind: "ready", modelId: "xenova-all-MiniLM-L6-v2"}),
		getIndexingState: () => IDLE_INDEXING,
		subscribeEngineState: () => () => {},
		subscribeIndexingState: () => () => {},
		subscribeRefreshSignal: () => () => {},
	};
	const feed = makeSimilarNotesFeed({
		statusHub,
		getSimilarNotesForNote: async ({noteId}) => {
			queries.push(noteId);
			return {items: [{id: "other.md", score: 0.9}], truncated: false};
		},
		isIndexEmpty: async () => false,
		isIgnoredPath: () => false,
		synchronizeIndex: async () => {},
		retryModelLoad: async () => {},
		refreshDebounceMs: REFRESH_DEBOUNCE_MS,
	});
	return {feed, queries};
}

test("a burst of refreshes re-ranks the active note once", async () => {
	const {feed, queries} = makeHarness();
	feed.setActiveNote("note.md");
	await tick();
	queries.length = 0;

	for (let i = 0; i < 1000; i++) feed.refresh();
	assert.deepStrictEqual(queries, [], "must not rank while the burst is still arriving");

	await tick(REFRESH_DEBOUNCE_MS * 4);
	assert.deepStrictEqual(queries, ["note.md"]);
	assert.strictEqual(feed.getSnapshot().items.length, 1);

	feed.dispose();
});

test("a refresh pending at dispose never runs", async () => {
	const {feed, queries} = makeHarness();
	feed.setActiveNote("note.md");
	await tick();
	queries.length = 0;

	feed.refresh();
	feed.dispose();
	await tick(REFRESH_DEBOUNCE_MS * 4);

	assert.deepStrictEqual(queries, []);
});

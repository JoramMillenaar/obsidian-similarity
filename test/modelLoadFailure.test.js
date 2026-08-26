const test = require("node:test");
const assert = require("node:assert");

global.window = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (id) => clearTimeout(id),
};

const {EmbeddingEngine} = require("../dist/embedding/engine.js");
const {makeStatusHub} = require("../dist/status/statusHub.js");
const {makeSimilarNotesFeed} = require("../dist/search/similarNotesFeed.js");

const MODEL_ID = "xenova-all-MiniLM-L6-v2";
const OTHER_MODEL_ID = "xenova-paraphrase-multilingual-MiniLM-L12-v2";

const IDLE_INDEXING = {isRunning: false, pending: 0, processed: 0, total: 0, failed: 0, failedIds: []};

function embedder() {
	return {embed: async () => null, unload() {}};
}

function makeEngine(loadEmbedder) {
	return new EmbeddingEngine({
		loadEmbedder: (config, onProgress, signal) => loadEmbedder(config.id, onProgress, signal),
		settingsRepo: {get: () => ({maxOverlapPercent: 0}), updatePartial: async () => {}},
		status: {update: () => {}, clear: () => {}},
	});
}

test("a failed model load parks the engine in an error state instead of 'idle'", async () => {
	const engine = makeEngine(async () => {
		throw new Error("Could not download the English model. Check your internet connection and try again.");
	});

	await assert.rejects(() => engine.requestModel(MODEL_ID));

	const status = engine.status();
	assert.strictEqual(status.kind, "error");
	assert.strictEqual(status.modelId, MODEL_ID);
	assert.match(status.message, /Check your internet connection/);
});

test("retry re-runs the failed load and recovers", async () => {
	let attempts = 0;
	const engine = makeEngine(async () => {
		attempts++;
		if (attempts === 1) throw new Error("offline");
		return embedder();
	});

	await assert.rejects(() => engine.requestModel(MODEL_ID));
	await engine.retry();

	assert.strictEqual(attempts, 2);
	assert.deepStrictEqual(engine.status(), {kind: "ready", modelId: MODEL_ID});
});

test("retry is a no-op unless the engine actually failed", async () => {
	let attempts = 0;
	const engine = makeEngine(async () => {
		attempts++;
		return embedder();
	});

	await engine.requestModel(MODEL_ID);
	await engine.retry();

	assert.strictEqual(attempts, 1);
});

test("a failed switch falls back to the model that was already loaded", async () => {
	const loaded = [];
	const engine = makeEngine(async (modelId) => {
		loaded.push(modelId);
		if (modelId === OTHER_MODEL_ID) throw new Error("Could not download the Multilingual (slower) model.");
		return embedder();
	});

	await engine.requestModel(MODEL_ID);
	await assert.rejects(() => engine.requestModel(OTHER_MODEL_ID));

	assert.deepStrictEqual(loaded, [MODEL_ID, OTHER_MODEL_ID, MODEL_ID], "the previous model is reloaded");
	assert.deepStrictEqual(engine.status(), {kind: "ready", modelId: MODEL_ID});
});

test("the failure is reported before the fallback has finished loading", async () => {
	let releaseFallback;
	let loadedOnce = false;
	const engine = makeEngine(async (modelId) => {
		if (modelId === OTHER_MODEL_ID) throw new Error("Could not download the Multilingual (slower) model.");
		if (!loadedOnce) {
			loadedOnce = true;
			return embedder();
		}
		return new Promise((resolve) => {
			releaseFallback = () => resolve(embedder());
		});
	});

	await engine.requestModel(MODEL_ID);

	const error = await engine.requestModel(OTHER_MODEL_ID).then(() => null, (e) => e);
	assert.ok(error, "the caller is told about the failure");

	// The fallback is still in flight at this point — the notice must not wait for it.
	const status = engine.status();
	assert.strictEqual(status.kind, "loading");
	assert.strictEqual(status.modelId, MODEL_ID, "already falling back to the previous model");

	releaseFallback();
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepStrictEqual(engine.status(), {kind: "ready", modelId: MODEL_ID});
});

test("a failed switch whose fallback also fails ends in the error state for the requested model", async () => {
	let firstLoadDone = false;
	const engine = makeEngine(async (modelId) => {
		if (modelId === MODEL_ID && firstLoadDone) throw new Error("cache miss while offline");
		if (modelId === OTHER_MODEL_ID) throw new Error("Could not download the Multilingual (slower) model.");
		firstLoadDone = true;
		return embedder();
	});

	await engine.requestModel(MODEL_ID);
	await assert.rejects(() => engine.requestModel(OTHER_MODEL_ID));

	const status = engine.status();
	assert.strictEqual(status.kind, "error");
	assert.strictEqual(status.modelId, OTHER_MODEL_ID);
	assert.match(status.message, /Multilingual/);
});

test("a first-ever load has nothing to fall back to and reports the failure", async () => {
	const loaded = [];
	const engine = makeEngine(async (modelId) => {
		loaded.push(modelId);
		throw new Error("Could not download the English model. Check your internet connection and try again.");
	});

	await assert.rejects(() => engine.requestModel(MODEL_ID));

	assert.deepStrictEqual(loaded, [MODEL_ID], "no fallback attempt without a previously loaded model");
	assert.strictEqual(engine.status().kind, "error");
});

test("embedding is refused rather than queued forever while no model is loaded", async () => {
	const engine = makeEngine(async () => {
		throw new Error("offline");
	});

	await assert.rejects(() => engine.requestModel(MODEL_ID));
	await assert.rejects(() => engine.embed("some text"), /failed to load/i);
});

test("the similar-notes feed surfaces the load failure instead of 'warming up' forever", async () => {
	const engine = makeEngine(async () => {
		throw new Error("Could not download the English model. Check your internet connection and try again.");
	});

	const statusHub = makeStatusHub({
		engine,
		indexer: {
			status: () => IDLE_INDEXING,
			subscribe: (fn) => {
				fn(IDLE_INDEXING);
				return () => {};
			},
		},
		refreshThrottleMs: 0,
	});

	let retried = 0;
	const feed = makeSimilarNotesFeed({
		statusHub,
		getSimilarNotesForNote: async () => [],
		isIndexEmpty: async () => false,
		isIgnoredPath: () => false,
		synchronizeIndex: async () => {},
		retryModelLoad: async () => {
			retried++;
			await engine.retry().catch(() => {});
		},
	});

	feed.setActiveNote("note.md");
	await assert.rejects(() => engine.requestModel(MODEL_ID));
	await new Promise((resolve) => setTimeout(resolve, 0));

	const notice = feed.getSnapshot().notice;
	assert.strictEqual(notice.kind, "model-error");
	assert.match(notice.message, /Check your internet connection/);

	await feed.retryModelLoad();
	assert.strictEqual(retried, 1);

	feed.dispose();
	statusHub.dispose();
});

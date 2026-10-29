const test = require("node:test");
const assert = require("node:assert");

global.window = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (id) => clearTimeout(id),
};

const {EmbeddingEngine, ModelNotReadyError, ModelRequestSupersededError} = require("../dist/embedding/engine.js");
const {makeSetModelDisabled} = require("../dist/app/setModelDisabled.js");
const {makeStatusHub} = require("../dist/status/statusHub.js");
const {makeSimilarNotesFeed} = require("../dist/search/similarNotesFeed.js");
const {EMBEDDING_MODEL} = require("../dist/constants.js");

const MODEL = EMBEDDING_MODEL;
const MODEL_ID = MODEL.id;

const IDLE_INDEXING = {isRunning: false, pending: 0, processed: 0, total: 0, failed: 0, failedIds: []};

function tick() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function embedder() {
	return {
		unloaded: 0,
		embed: async () => ({chunks: [{embedding: new Int8Array(1), start: 0, end: 1, hash: "h"}]}),
		unload() {
			this.unloaded++;
		},
	};
}

function deviceSettings(initial = {modelDisabled: false}) {
	let current = initial;
	return {
		get: () => current,
		updatePartial(patch) {
			current = {...current, ...patch};
		},
	};
}

function makeEngine(loadEmbedder) {
	return new EmbeddingEngine({
		loadEmbedder: (config, onProgress, signal) => loadEmbedder(config.id, onProgress, signal),
		status: {update: () => {}, clear: () => {}},
	});
}

test("a disabled engine ignores model requests until it is enabled", async () => {
	let loads = 0;
	const engine = makeEngine(async () => {
		loads++;
		return embedder();
	});

	await engine.disable();
	assert.deepStrictEqual(engine.status(), {kind: "disabled"});

	await engine.requestModel(MODEL);
	await engine.retry();
	assert.strictEqual(loads, 0, "requestModel and retry are no-ops while disabled");
	assert.deepStrictEqual(engine.status(), {kind: "disabled"});
});

test("disabling a ready engine flips at once and hands the model to unload", async () => {
	const loaded = embedder();
	loaded.embed = () => new Promise(() => {});
	const engine = makeEngine(async () => loaded);
	await engine.requestModel(MODEL);

	void engine.embed("in progress", {lane: "background"});
	await engine.disable();

	// Settling work still in progress is the embedder's job: unloading it rejects what it
	// was still waiting on and lets the running inference finish first (see InferenceQueue).
	assert.deepStrictEqual(engine.status(), {kind: "disabled"});
	assert.strictEqual(loaded.unloaded, 1);
	await assert.rejects(engine.embed("after", {lane: "interactive"}), /disabled/);
});

test("embedding while disabled is refused with a ModelNotReadyError for the disabled state", async () => {
	const engine = makeEngine(async () => embedder());
	await engine.disable();

	const error = await engine.embed("text").then(() => null, (e) => e);
	assert.ok(error instanceof ModelNotReadyError);
	assert.strictEqual(error.status, "disabled");
	assert.match(error.message, /disabled on this device/);
});

test("disabling mid-load abandons the load instead of letting it finish", async () => {
	let release;
	let aborted = false;
	const engine = makeEngine((modelId, onProgress, signal) => new Promise((resolve) => {
		signal.addEventListener("abort", () => {
			aborted = true;
		});
		release = () => resolve(embedder());
	}));

	const loading = engine.requestModel(MODEL);
	await tick();
	assert.strictEqual(engine.status().kind, "loading");

	await engine.disable();
	assert.ok(aborted, "the load's signal is aborted");
	assert.deepStrictEqual(engine.status(), {kind: "disabled"});

	release();
	const error = await loading.then(() => null, (e) => e);
	assert.ok(error instanceof ModelRequestSupersededError);
	assert.deepStrictEqual(engine.status(), {kind: "disabled"}, "a late load result does not revive the model");
});

test("enabling loads the requested model; a no-op once enabled", async () => {
	const loaded = [];
	const engine = makeEngine(async (modelId) => {
		loaded.push(modelId);
		return embedder();
	});
	await engine.disable();

	await engine.enable(MODEL);
	assert.deepStrictEqual(loaded, [MODEL_ID]);
	assert.deepStrictEqual(engine.status(), {kind: "ready", modelId: MODEL_ID});

	await engine.enable(MODEL);
	assert.deepStrictEqual(loaded, [MODEL_ID]);
});

test("the use case remembers the choice per device and applies it to the engine", async () => {
	const loaded = [];
	const engine = makeEngine(async (modelId) => {
		loaded.push(modelId);
		return embedder();
	});
	const device = deviceSettings();
	const setModelDisabled = makeSetModelDisabled({deviceSettingsRepo: device, engine});
	await engine.requestModel(MODEL);

	await setModelDisabled(true);
	assert.deepStrictEqual(engine.status(), {kind: "disabled"});
	assert.deepStrictEqual(device.get(), {modelDisabled: true}, "the engine knows nothing about this; the use case does");

	await setModelDisabled(false);
	assert.deepStrictEqual(engine.status(), {kind: "ready", modelId: MODEL_ID});
	assert.deepStrictEqual(device.get(), {modelDisabled: false});
	assert.deepStrictEqual(loaded, [MODEL_ID, MODEL_ID], "re-enabling loads the model again");
});

test("disable and enable are immediate for observers: no restart, notice flips both ways", async () => {
	const engine = makeEngine(async () => embedder());
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
	const feed = makeSimilarNotesFeed({
		statusHub,
		getSimilarNotesForNote: async () => ({items: [{id: "other.md", score: 0.9}], truncated: false}),
		isIndexEmpty: async () => false,
		isIgnoredPath: () => false,
		synchronizeIndex: async () => {},
		retryModelLoad: async () => {},
	});

	await engine.requestModel(MODEL);
	feed.setActiveNote("note.md");
	await tick();
	assert.strictEqual(feed.getSnapshot().notice, undefined);

	await engine.disable();
	await tick();
	let snapshot = feed.getSnapshot();
	assert.deepStrictEqual(snapshot.notice, {kind: "model-disabled"});
	assert.strictEqual(snapshot.items.length, 1, "stored vectors still serve results while disabled");

	await engine.enable(MODEL);
	await tick();
	snapshot = feed.getSnapshot();
	assert.strictEqual(snapshot.notice, undefined);
	assert.strictEqual(snapshot.items.length, 1);

	feed.dispose();
	statusHub.dispose();
});

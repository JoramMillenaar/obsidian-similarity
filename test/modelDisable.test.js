const test = require("node:test");
const assert = require("node:assert");

global.window = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (id) => clearTimeout(id),
};

const {EmbeddingEngine, ModelNotReadyError, ModelRequestSupersededError} = require("../dist/embedding/engine.js");
const {makeSetModelDisabled} = require("../dist/app/setModelDisabled.js");
const {makeUpdateSettings} = require("../dist/app/updateSettings.js");
const {makeStatusHub} = require("../dist/status/statusHub.js");
const {makeSimilarNotesFeed} = require("../dist/search/similarNotesFeed.js");

const MODEL_ID = "xenova-all-MiniLM-L6-v2";

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

const settingsRepo = {get: () => ({maxOverlapPercent: 0, embeddingModelId: MODEL_ID}), updatePartial: async () => {}};

function makeEngine(loadEmbedder) {
	return new EmbeddingEngine({
		loadEmbedder: (config, onProgress, signal) => loadEmbedder(config.id, onProgress, signal),
		settingsRepo,
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

	await engine.requestModel(MODEL_ID);
	await engine.retry();
	assert.strictEqual(loads, 0, "requestModel and retry are no-ops while disabled");
	assert.deepStrictEqual(engine.status(), {kind: "disabled"});
});

test("disabling a ready engine unloads the model and drops queued work", async () => {
	const loaded = embedder();
	let releaseInFlight;
	loaded.embed = () => new Promise((resolve) => {
		releaseInFlight = () => resolve({chunks: [{embedding: new Int8Array(1), start: 0, end: 1, hash: "h"}]});
	});
	const engine = makeEngine(async () => loaded);
	await engine.requestModel(MODEL_ID);

	const inFlight = engine.embed("first");
	const queued = engine.embed("second");
	const disabling = engine.disable();

	assert.deepStrictEqual(engine.status(), {kind: "disabled"}, "the state flips before in-flight work settles");
	await assert.rejects(queued, /disabled/);

	releaseInFlight();
	await disabling;
	await inFlight;
	assert.strictEqual(loaded.unloaded, 1, "unloaded only after the in-flight job finished");
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

	const loading = engine.requestModel(MODEL_ID);
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

	await engine.enable(MODEL_ID);
	assert.deepStrictEqual(loaded, [MODEL_ID]);
	assert.deepStrictEqual(engine.status(), {kind: "ready", modelId: MODEL_ID});

	await engine.enable(MODEL_ID);
	assert.deepStrictEqual(loaded, [MODEL_ID]);
});

test("the use case remembers the choice per device and applies it to the engine", async () => {
	const loaded = [];
	const engine = makeEngine(async (modelId) => {
		loaded.push(modelId);
		return embedder();
	});
	const device = deviceSettings();
	const setModelDisabled = makeSetModelDisabled({deviceSettingsRepo: device, settingsRepo, engine});
	await engine.requestModel(MODEL_ID);

	await setModelDisabled(true);
	assert.deepStrictEqual(engine.status(), {kind: "disabled"});
	assert.deepStrictEqual(device.get(), {modelDisabled: true}, "the engine knows nothing about this; the use case does");

	await setModelDisabled(false);
	assert.deepStrictEqual(engine.status(), {kind: "ready", modelId: MODEL_ID});
	assert.deepStrictEqual(device.get(), {modelDisabled: false});
	assert.deepStrictEqual(loaded, [MODEL_ID, MODEL_ID], "re-enabling loads the model named in settings");
});

test("switching language while disabled keeps the choice and switches the index without a model", async () => {
	const OTHER_MODEL_ID = "xenova-paraphrase-multilingual-MiniLM-L12-v2";
	const loaded = [];
	const engine = makeEngine(async (modelId) => {
		loaded.push(modelId);
		return embedder();
	});
	let settings = {maxOverlapPercent: 0, embeddingModelId: MODEL_ID};
	const repo = {get: () => settings, updatePartial: async (patch) => Object.assign(settings, patch)};
	const indexesOpened = [];
	const updateSettings = makeUpdateSettings({
		settingsRepo: repo,
		engine,
		resync: async () => {},
		switchIndex: async (modelId) => indexesOpened.push(modelId),
	});
	await engine.disable();

	await updateSettings({embeddingModelId: OTHER_MODEL_ID});

	assert.strictEqual(settings.embeddingModelId, OTHER_MODEL_ID, "the choice is persisted without a load");
	assert.deepStrictEqual(indexesOpened, [OTHER_MODEL_ID], "results now come from that model's index");
	assert.deepStrictEqual(loaded, [], "no model was spun up");
	assert.deepStrictEqual(engine.status(), {kind: "disabled"});

	await engine.enable(settings.embeddingModelId);
	assert.deepStrictEqual(loaded, [OTHER_MODEL_ID], "enabling picks up the language chosen while disabled");
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
		getSimilarNotesForNote: async () => [{id: "other.md", score: 0.9}],
		isIndexEmpty: async () => false,
		isIgnoredPath: () => false,
		synchronizeIndex: async () => {},
		retryModelLoad: async () => {},
	});

	await engine.requestModel(MODEL_ID);
	feed.setActiveNote("note.md");
	await tick();
	assert.strictEqual(feed.getSnapshot().notice, undefined);

	await engine.disable();
	await tick();
	let snapshot = feed.getSnapshot();
	assert.deepStrictEqual(snapshot.notice, {kind: "model-disabled"});
	assert.strictEqual(snapshot.items.length, 1, "stored vectors still serve results while disabled");

	await engine.enable(MODEL_ID);
	await tick();
	snapshot = feed.getSnapshot();
	assert.strictEqual(snapshot.notice, undefined);
	assert.strictEqual(snapshot.items.length, 1);

	feed.dispose();
	statusHub.dispose();
});

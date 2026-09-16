const test = require("node:test");
const assert = require("node:assert");

global.window = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (id) => clearTimeout(id),
};

const {EmbeddingEngine} = require("../dist/embedding/engine.js");

const MODEL_ID = "xenova-all-MiniLM-L6-v2";
const OTHER_MODEL_ID = "xenova-paraphrase-multilingual-MiniLM-L12-v2";
const THIRD_MODEL_ID = "xenova-bge-small-zh-v1.5";

function makeEngine(loadEmbedder) {
	return new EmbeddingEngine({
		loadEmbedder: (config, onProgress, signal) => loadEmbedder(config.id, onProgress, signal),
		settingsRepo: {get: () => ({maxOverlapPercent: 0}), updatePartial: async () => {}},
		status: {update: () => {}, clear: () => {}},
	});
}

test("the outgoing model is released before the incoming one starts loading", async () => {
	const events = [];
	let releaseUnload;

	const engine = makeEngine(async (modelId) => {
		events.push(`load:${modelId}`);
		return {
			embed: async () => null,
			unload() {
				events.push(`unload:${modelId}`);
				return new Promise((resolve) => {
					releaseUnload = () => {
						events.push(`released:${modelId}`);
						resolve();
					};
				});
			},
		};
	});

	await engine.requestModel(MODEL_ID);

	const switched = engine.requestModel(OTHER_MODEL_ID);
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.deepStrictEqual(events, [`load:${MODEL_ID}`, `unload:${MODEL_ID}`],
		"the switch waits on the release instead of loading over the top of it");

	releaseUnload();
	await switched;

	assert.deepStrictEqual(events, [
		`load:${MODEL_ID}`,
		`unload:${MODEL_ID}`,
		`released:${MODEL_ID}`,
		`load:${OTHER_MODEL_ID}`,
	]);
});

test("an in-flight embed finishes before the outgoing model is released", async () => {
	const events = [];
	let finishEmbed;

	const engine = makeEngine(async (modelId) => ({
		embed: () => new Promise((resolve) => {
			finishEmbed = () => {
				events.push(`embed-done:${modelId}`);
				resolve({chunks: [], metadata: {embeddingModelId: modelId, maxOverlapPercent: 0}});
			};
		}),
		async unload() {
			events.push(`unload:${modelId}`);
		},
	}));

	await engine.requestModel(MODEL_ID);

	const embedding = engine.embed("some text");
	await new Promise((resolve) => setTimeout(resolve, 0));

	const switched = engine.requestModel(OTHER_MODEL_ID);
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.deepStrictEqual(events, [], "sessions are not torn down under a running inference");

	finishEmbed();
	await embedding;
	await switched;

	assert.deepStrictEqual(events, [`embed-done:${MODEL_ID}`, `unload:${MODEL_ID}`]);
});

test("a synchronous unload still gates the load, and the switch completes", async () => {
	const events = [];
	const engine = makeEngine(async (modelId) => {
		events.push(`load:${modelId}`);
		return {
			embed: async () => null,
			// legacy shape: returns undefined rather than a promise
			unload() {
				events.push(`unload:${modelId}`);
			},
		};
	});

	await engine.requestModel(MODEL_ID);
	await engine.requestModel(OTHER_MODEL_ID);

	assert.deepStrictEqual(events, [`load:${MODEL_ID}`, `unload:${MODEL_ID}`, `load:${OTHER_MODEL_ID}`]);
	assert.deepStrictEqual(engine.status(), {kind: "ready", modelId: OTHER_MODEL_ID});
});

test("superseding a still-loading switch waits for its teardown before the next model loads", async () => {
	const events = [];
	let releaseAbortedTeardown;

	const engine = makeEngine((modelId, _onProgress, signal) => new Promise((resolve, reject) => {
		events.push(`load-start:${modelId}`);
		if (modelId === OTHER_MODEL_ID) {
			// Mirrors WorkerMessenger.initialize(): on abort it doesn't reject until it has
			// finished tearing down the worker it started constructing.
			signal.addEventListener("abort", () => {
				releaseAbortedTeardown = () => {
					events.push(`teardown-done:${modelId}`);
					reject(new Error("aborted"));
				};
			});
			return;
		}
		resolve({embed: async () => null, unload: async () => { events.push(`unload:${modelId}`); }});
	}));

	await engine.requestModel(MODEL_ID);

	const switchToOther = engine.requestModel(OTHER_MODEL_ID);
	switchToOther.catch(() => {});
	await new Promise((resolve) => setTimeout(resolve, 0));

	const switchToThird = engine.requestModel(THIRD_MODEL_ID);
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.deepStrictEqual(events, [`load-start:${MODEL_ID}`, `unload:${MODEL_ID}`, `load-start:${OTHER_MODEL_ID}`],
		"the third model must not start loading while the superseded switch is still tearing down");

	releaseAbortedTeardown();
	await switchToThird;

	assert.deepStrictEqual(events, [
		`load-start:${MODEL_ID}`,
		`unload:${MODEL_ID}`,
		`load-start:${OTHER_MODEL_ID}`,
		`teardown-done:${OTHER_MODEL_ID}`,
		`load-start:${THIRD_MODEL_ID}`,
	]);
});

test("superseding a switch that just finished loading waits for its self-unload before the next model loads", async () => {
	const events = [];
	let resolveOtherLoad;

	const engine = makeEngine((modelId) => new Promise((resolve) => {
		events.push(`load-start:${modelId}`);
		const port = {
			embed: async () => null,
			unload: () => new Promise((resolveUnload) => {
				events.push(`unload-start:${modelId}`);
				setTimeout(() => {
					events.push(`unload-done:${modelId}`);
					resolveUnload();
				}, 0);
			}),
		};
		if (modelId === OTHER_MODEL_ID) {
			resolveOtherLoad = () => resolve(port);
			return;
		}
		resolve(port);
	}));

	await engine.requestModel(MODEL_ID);

	const switchToOther = engine.requestModel(OTHER_MODEL_ID);
	switchToOther.catch(() => {});
	// Waiting on MODEL_ID's own (also timer-based) self-unload takes two event-loop
	// turns: one for the outgoing unload's timer to fire, one for the continuation that
	// calls loadEmbedder (and sets resolveOtherLoad) to run.
	while (!resolveOtherLoad) await new Promise((resolve) => setTimeout(resolve, 0));

	// The switch to OTHER_MODEL_ID resolves successfully right as THIRD_MODEL_ID
	// supersedes it, so it must unload itself before THIRD_MODEL_ID starts loading.
	const switchToThird = engine.requestModel(THIRD_MODEL_ID);
	resolveOtherLoad();
	await switchToOther.catch(() => {});
	await switchToThird;

	assert.deepStrictEqual(events, [
		`load-start:${MODEL_ID}`,
		`unload-start:${MODEL_ID}`,
		`unload-done:${MODEL_ID}`,
		`load-start:${OTHER_MODEL_ID}`,
		`unload-start:${OTHER_MODEL_ID}`,
		`unload-done:${OTHER_MODEL_ID}`,
		`load-start:${THIRD_MODEL_ID}`,
	]);
});

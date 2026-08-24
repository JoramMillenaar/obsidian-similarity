const test = require("node:test");
const assert = require("node:assert");

global.window = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (id) => clearTimeout(id),
};

const {makeStatusHub} = require("../dist/status/statusHub.js");
const {subscribeBanner} = require("../dist/ui/banner.js");

const IDLE_INDEXING = {isRunning: false, pending: 0, processed: 0, total: 0, failed: 0, failedIds: []};

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
		push(next) {
			status = next;
			for (const fn of listeners) fn(status);
		},
	};
}

function makeFakeIndexer(initial) {
	let snapshot = initial;
	const listeners = new Set();
	return {
		status: () => snapshot,
		subscribe(fn) {
			listeners.add(fn);
			fn(snapshot);
			return () => listeners.delete(fn);
		},
		push(next) {
			snapshot = next;
			for (const fn of listeners) fn(snapshot);
		},
	};
}

function makeHub(overrides = {}) {
	const engine = overrides.engine ?? makeFakeEngine({kind: "ready", modelId: "m1"});
	const indexer = overrides.indexer ?? makeFakeIndexer(IDLE_INDEXING);
	const hub = makeStatusHub({engine, indexer, refreshThrottleMs: overrides.refreshThrottleMs ?? 0});
	return {hub, engine, indexer};
}

test("the banner reflects model-download state with no note-specific context", () => {
	const {hub, engine} = makeHub({
		engine: makeFakeEngine({kind: "loading", modelId: "m1", progress: 40, phase: "downloading"}),
	});

	const seen = [];
	subscribeBanner(hub, (banner) => seen.push(banner));

	assert.deepStrictEqual(seen[seen.length - 1], {
		visible: true,
		message: "Setting up...",
		processed: 40,
		total: 100,
	});

	engine.push({kind: "ready", modelId: "m1"});
	assert.strictEqual(seen[seen.length - 1].visible, false);
	hub.dispose();
});

test("the banner stops emitting once the hub is disposed", () => {
	const {hub, engine, indexer} = makeHub();

	let calls = 0;
	subscribeBanner(hub, () => calls++);
	hub.dispose();

	const before = calls;
	engine.push({kind: "loading", modelId: "m1", progress: 10, phase: "downloading"});
	indexer.push({...IDLE_INDEXING, isRunning: true, total: 10});

	assert.strictEqual(calls, before, "no banner emissions after dispose");
});

test("a small indexing run does not raise a banner, a large one does", () => {
	const {hub, indexer} = makeHub();

	const seen = [];
	subscribeBanner(hub, (banner) => seen.push(banner));

	indexer.push({...IDLE_INDEXING, isRunning: true, pending: 3, total: 3});
	assert.strictEqual(seen[seen.length - 1].visible, false, "a handful of notes is not worth a banner");

	indexer.push({...IDLE_INDEXING, isRunning: true, pending: 40, processed: 2, total: 42});
	assert.strictEqual(seen[seen.length - 1].visible, true);
	assert.strictEqual(seen[seen.length - 1].total, 42);

	hub.dispose();
});

test("a model still downloading outranks indexing progress in the banner", () => {
	const {hub, indexer} = makeHub({
		engine: makeFakeEngine({kind: "loading", modelId: "m1", progress: 20, phase: "downloading"}),
	});

	const seen = [];
	subscribeBanner(hub, (banner) => seen.push(banner));
	indexer.push({...IDLE_INDEXING, isRunning: true, pending: 40, total: 42});

	assert.strictEqual(seen[seen.length - 1].message, "Setting up...");
	hub.dispose();
});

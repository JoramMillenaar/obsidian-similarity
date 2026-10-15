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
	const unsubscribe = subscribeBanner(hub, (banner) => seen.push(banner), 0);

	assert.deepStrictEqual(seen[seen.length - 1], {
		visible: true,
		message: "Setting up...",
		processed: 40,
		total: 100,
		wasmWarning: false,
		tone: "info",
	});

	engine.push({kind: "ready", modelId: "m1"});
	assert.strictEqual(seen[seen.length - 1].visible, false);
	unsubscribe();
	hub.dispose();
});

test("the banner stops emitting once the hub is disposed", () => {
	const {hub, engine, indexer} = makeHub();

	let calls = 0;
	subscribeBanner(hub, () => calls++, 0);
	hub.dispose();

	const before = calls;
	engine.push({kind: "loading", modelId: "m1", progress: 10, phase: "downloading"});
	indexer.push({...IDLE_INDEXING, isRunning: true, total: 10});

	assert.strictEqual(calls, before, "no banner emissions after dispose");
});

test("a small indexing run does not raise a banner, a large one does", () => {
	const {hub, indexer} = makeHub();

	const seen = [];
	const unsubscribe = subscribeBanner(hub, (banner) => seen.push(banner), 0);

	indexer.push({...IDLE_INDEXING, isRunning: true, pending: 3, total: 3});
	assert.strictEqual(seen[seen.length - 1].visible, false, "a handful of notes is not worth a banner");

	indexer.push({...IDLE_INDEXING, isRunning: true, pending: 40, processed: 2, total: 42});
	assert.strictEqual(seen[seen.length - 1].visible, true);
	assert.strictEqual(seen[seen.length - 1].total, 42);

	unsubscribe();
	hub.dispose();
});

test("a wasm device raises a warning alongside a visible indexing banner, not while idle", () => {
	const {hub, engine, indexer} = makeHub({
		engine: makeFakeEngine({kind: "ready", modelId: "m1", device: "wasm"}),
	});

	const seen = [];
	const unsubscribe = subscribeBanner(hub, (banner) => seen.push(banner), 0);

	assert.strictEqual(seen[seen.length - 1].wasmWarning, false, "no warning while idle, even on wasm");

	indexer.push({...IDLE_INDEXING, isRunning: true, pending: 40, processed: 2, total: 42});
	assert.strictEqual(seen[seen.length - 1].visible, true);
	assert.strictEqual(seen[seen.length - 1].wasmWarning, true);

	engine.push({kind: "ready", modelId: "m1", device: "webgpu"});
	assert.strictEqual(seen[seen.length - 1].wasmWarning, false, "no warning on webgpu");

	unsubscribe();
	hub.dispose();
});

test("a model still downloading outranks indexing progress in the banner", () => {
	const {hub, indexer} = makeHub({
		engine: makeFakeEngine({kind: "loading", modelId: "m1", progress: 20, phase: "downloading"}),
	});

	const seen = [];
	const unsubscribe = subscribeBanner(hub, (banner) => seen.push(banner), 0);
	indexer.push({...IDLE_INDEXING, isRunning: true, pending: 40, total: 42});

	assert.strictEqual(seen[seen.length - 1].message, "Setting up...");
	unsubscribe();
	hub.dispose();
});

test("a disabled model raises a warning banner that outranks indexing progress", () => {
	const {hub, engine, indexer} = makeHub({
		engine: makeFakeEngine({kind: "disabled"}),
	});

	const seen = [];
	const unsubscribe = subscribeBanner(hub, (banner) => seen.push(banner), 0);

	let banner = seen[seen.length - 1];
	assert.strictEqual(banner.visible, true);
	assert.strictEqual(banner.tone, "warning");
	assert.strictEqual(banner.action, "open-settings");
	assert.match(banner.message, /disabled on this device/);

	indexer.push({...IDLE_INDEXING, isRunning: true, pending: 40, processed: 2, total: 42});
	banner = seen[seen.length - 1];
	assert.strictEqual(banner.tone, "warning", "queued edits while paused must not look like indexing");
	assert.strictEqual(banner.total, 0);

	engine.push({kind: "ready", modelId: "m1"});
	banner = seen[seen.length - 1];
	assert.strictEqual(banner.tone, "info");
	assert.strictEqual(banner.total, 42, "re-enabling hands the banner back to indexing");

	unsubscribe();
	hub.dispose();
});

const {
	IndexingMessages,
	INDEXING_WELCOME_MESSAGE,
	INDEXING_FINISHING_MESSAGE,
	isNearlyDone,
	titleFromNoteId,
} = require("../dist/status/indexingMessages.js");

test("the indexing banner opens with the on-device welcome and is marked as rotating", () => {
	const {hub, indexer} = makeHub();

	const seen = [];
	const unsubscribe = subscribeBanner(hub, (banner) => seen.push(banner), 0);
	indexer.push({...IDLE_INDEXING, isRunning: true, pending: 40, processed: 2, total: 42});

	const banner = seen[seen.length - 1];
	assert.strictEqual(banner.message, INDEXING_WELCOME_MESSAGE);
	assert.match(banner.message, /on your device/);
	assert.strictEqual(banner.rotating, true);

	unsubscribe();
	hub.dispose();
});

test("the indexing banner rotates to a new message on a timer and stops once indexing ends", () => {
	const realWindow = global.window;
	const timers = [];
	global.window = {
		setTimeout: (fn, ms) => { timers.push({fn, ms, cleared: false}); return timers.length; },
		clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
	};
	try {
		const {hub, indexer} = makeHub();
		const seen = [];
		const unsubscribe = subscribeBanner(hub, (banner) => seen.push(banner), 0);
		indexer.push({...IDLE_INDEXING, isRunning: true, pending: 40, processed: 2, total: 42, currentNoteId: "Journal/Trip to Lisbon.md"});

		const rotate = timers.find((t) => t.ms > 1000 && !t.cleared);
		assert.ok(rotate, "a rotation timer is armed while the banner shows");
		rotate.fired = true;
		rotate.fn();
		const rotated = seen[seen.length - 1];
		assert.notStrictEqual(rotated.message, INDEXING_WELCOME_MESSAGE);
		assert.strictEqual(rotated.processed, 2, "rotation keeps the progress");

		indexer.push({...IDLE_INDEXING});
		assert.ok(timers.filter((t) => t.ms > 1000 && !t.fired).every((t) => t.cleared), "rotation stops when the banner hides");

		unsubscribe();
		hub.dispose();
	} finally {
		global.window = realWindow;
	}
});

test("indexing messages mix in recent note titles", () => {
	const messages = new IndexingMessages();
	const ctx = {recentTitles: ["Trip to Lisbon"]};
	const sequence = Array.from({length: 12}, () => messages.next(ctx));

	assert.strictEqual(sequence[0], INDEXING_WELCOME_MESSAGE);
	assert.ok(sequence.some((m) => m.includes("\"Trip to Lisbon\"")), "a personal message uses the title");
});

test("note ids become readable titles, and untitled notes are skipped", () => {
	assert.strictEqual(titleFromNoteId("Journal/2024/Trip to Lisbon.md"), "Trip to Lisbon");
	assert.strictEqual(titleFromNoteId("Top level.md"), "Top level");
	assert.strictEqual(titleFromNoteId("Inbox/Untitled 3.md"), undefined);
	assert.strictEqual(titleFromNoteId(undefined), undefined);
});

test("the banner switches to a finishing message near the end and does not rotate away from it", () => {
	const realWindow = global.window;
	const timers = [];
	global.window = {
		setTimeout: (fn, ms) => { timers.push({fn, ms, cleared: false}); return timers.length; },
		clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
	};
	try {
		const {hub, indexer} = makeHub();
		const seen = [];
		const unsubscribe = subscribeBanner(hub, (banner) => seen.push(banner), 0);
		indexer.push({...IDLE_INDEXING, isRunning: true, pending: 40, processed: 2, total: 42});
		indexer.push({...IDLE_INDEXING, isRunning: true, pending: 4, processed: 38, total: 42});
		assert.strictEqual(seen[seen.length - 1].message, INDEXING_FINISHING_MESSAGE);

		const count = seen.length;
		for (const t of timers.filter((t) => t.ms > 1000 && !t.cleared)) t.fn();
		assert.strictEqual(seen.length, count, "rotation timers no longer emit new messages");
		indexer.push({...IDLE_INDEXING, isRunning: true, pending: 3, processed: 39, total: 42});
		assert.strictEqual(seen[seen.length - 1].message, INDEXING_FINISHING_MESSAGE);

		unsubscribe();
		hub.dispose();
	} finally {
		global.window = realWindow;
	}
});

test("isNearlyDone covers the last stretch of both large and small queues", () => {
	assert.strictEqual(isNearlyDone(0, 0), false);
	assert.strictEqual(isNearlyDone(2, 42), false);
	assert.strictEqual(isNearlyDone(38, 42), true);
	assert.strictEqual(isNearlyDone(90, 100), true);
	assert.strictEqual(isNearlyDone(500, 1000), false);
	assert.strictEqual(isNearlyDone(4, 10), false);
});

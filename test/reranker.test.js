const test = require("node:test");
const assert = require("node:assert");

/** Manual clock, so the idle teardown is testable without waiting for it. */
function makeClock() {
	let now = 0;
	let seq = 0;
	const timers = new Map();
	return {
		setTimeout(fn, ms) {
			const id = ++seq;
			timers.set(id, {at: now + (ms || 0), fn});
			return id;
		},
		clearTimeout(id) {
			timers.delete(id);
		},
		async advance(ms) {
			now += ms;
			for (const [id, timer] of [...timers].sort(([, a], [, b]) => a.at - b.at)) {
				if (timer.at > now) continue;
				timers.delete(id);
				timer.fn();
			}
			await flush();
		},
	};
}

function flush() {
	return new Promise((resolve) => setImmediate(resolve));
}

const clock = makeClock();
global.window = clock;

const {Reranker} = require("../dist/reranking/reranker.js");
const {RERANKER_MODEL} = require("../dist/constants.js");

const IDLE_MS = 1000;

function fakeWorker() {
	const listeners = {message: [], error: []};
	return {
		sent: [],
		terminated: false,
		addEventListener(type, listener) {
			listeners[type].push(listener);
		},
		postMessage(message) {
			this.sent.push(message);
		},
		terminate() {
			this.terminated = true;
		},
		reply(data) {
			for (const listener of listeners.message) listener({data});
		},
		crash(message) {
			for (const listener of listeners.error) listener({message});
		},
		lastScoreRequest() {
			return this.sent.filter((message) => message.type === "reranker-score").at(-1);
		},
	};
}

function makeReranker() {
	const workers = [];
	const reranker = new Reranker({
		config: RERANKER_MODEL,
		startWorker: () => {
			const worker = fakeWorker();
			workers.push(worker);
			return worker;
		},
		allowWebGpu: true,
		idleMs: IDLE_MS,
	});
	return {reranker, workers};
}

test("the first lease loads the model, and it is unloaded once the last lease has been released for the idle time", async () => {
	const {reranker, workers} = makeReranker();
	assert.deepStrictEqual(reranker.status(), {kind: "unloaded"});

	const lease = reranker.acquire();
	assert.strictEqual(workers.length, 1);
	assert.strictEqual(workers[0].sent[0].type, "reranker-init");
	assert.strictEqual(reranker.status().kind, "loading");

	workers[0].reply({type: "reranker-ready", device: "webgpu"});
	assert.deepStrictEqual(reranker.status(), {kind: "ready", device: "webgpu"});

	lease.release();
	lease.release();
	await clock.advance(IDLE_MS - 1);
	assert.strictEqual(workers[0].terminated, false);
	await clock.advance(1);
	assert.strictEqual(workers[0].terminated, true);
	assert.deepStrictEqual(reranker.status(), {kind: "unloaded"});
});

test("a lease taken during the idle time keeps the loaded model", async () => {
	const {reranker, workers} = makeReranker();
	reranker.acquire().release();
	workers[0].reply({type: "reranker-ready", device: "wasm"});

	await clock.advance(IDLE_MS / 2);
	const lease = reranker.acquire();
	await clock.advance(IDLE_MS * 2);
	assert.strictEqual(workers.length, 1);
	assert.strictEqual(workers[0].terminated, false);

	lease.release();
	await clock.advance(IDLE_MS);
	assert.strictEqual(workers[0].terminated, true);
});

test("a model still downloading is not cut off by the idle time", async () => {
	const {reranker, workers} = makeReranker();
	reranker.acquire().release();

	await clock.advance(IDLE_MS * 3);
	assert.strictEqual(workers[0].terminated, false);

	workers[0].reply({type: "reranker-ready", device: "wasm"});
	await flush();
	await clock.advance(IDLE_MS);
	assert.strictEqual(workers[0].terminated, true);
});

test("scores wait for the model to load, and passages already scored for the search are not sent again", async () => {
	const {reranker, workers} = makeReranker();
	reranker.acquire();
	const first = reranker.score("why?", ["a", "b"]);
	await flush();
	assert.strictEqual(workers[0].lastScoreRequest(), undefined);

	workers[0].reply({type: "reranker-ready", device: "wasm"});
	await flush();
	const request = workers[0].lastScoreRequest();
	assert.deepStrictEqual(request.passages, ["a", "b"]);
	workers[0].reply({type: "reranker-scores", requestId: request.requestId, scores: [0.9, 0.1]});
	assert.deepStrictEqual(await first, [0.9, 0.1]);

	const second = reranker.score("why?", ["b", "c"]);
	await flush();
	const next = workers[0].lastScoreRequest();
	assert.deepStrictEqual(next.passages, ["c"]);
	workers[0].reply({type: "reranker-scores", requestId: next.requestId, scores: [0.5]});
	assert.deepStrictEqual(await second, [0.1, 0.5]);
});

test("aborting a score request rejects it and tells the worker to stop", async () => {
	const {reranker, workers} = makeReranker();
	reranker.acquire();
	workers[0].reply({type: "reranker-ready", device: "wasm"});

	const controller = new AbortController();
	const scoring = reranker.score("why?", ["a"], controller.signal);
	await flush();
	const {requestId} = workers[0].lastScoreRequest();
	controller.abort();

	await assert.rejects(scoring, {name: "AbortError"});
	assert.deepStrictEqual(workers[0].sent.at(-1), {type: "reranker-cancel", requestId});
});

test("a failed load shows the error and fails waiting scores; retrying loads it again", async () => {
	const {reranker, workers} = makeReranker();
	reranker.acquire();
	const scoring = reranker.score("why?", ["a"]);
	workers[0].reply({type: "reranker-load-error", message: "Could not download the reranking model."});

	await assert.rejects(scoring, /Could not download/);
	assert.deepStrictEqual(reranker.status(), {kind: "error", message: "Could not download the reranking model."});
	assert.strictEqual(workers[0].terminated, true);

	reranker.retry();
	assert.strictEqual(workers.length, 2);
	assert.strictEqual(reranker.status().kind, "loading");
});

test("a worker crash fails scores in flight", async () => {
	const {reranker, workers} = makeReranker();
	reranker.acquire();
	workers[0].reply({type: "reranker-ready", device: "wasm"});
	const scoring = reranker.score("why?", ["a"]);
	await flush();
	workers[0].crash("out of memory");

	await assert.rejects(scoring, /crashed: out of memory/);
	assert.strictEqual(reranker.status().kind, "error");
});

test("download progress follows the weights, the largest file", () => {
	const {reranker, workers} = makeReranker();
	reranker.acquire();
	const progress = (total, value) => workers[0].reply({type: "reranker-progress", progress: value, file: "f", loaded: 0, total});

	progress(500_000, 50);
	assert.deepStrictEqual(reranker.status(), {kind: "loading", progress: null});
	progress(280_000_000, 10);
	progress(17_000_000, 90);
	assert.deepStrictEqual(reranker.status(), {kind: "loading", progress: 10});
});

test("dispose terminates the worker and fails what was waiting on it", async () => {
	const {reranker, workers} = makeReranker();
	reranker.acquire();
	const scoring = reranker.score("why?", ["a"]);
	reranker.dispose();

	await assert.rejects(scoring);
	assert.strictEqual(workers[0].terminated, true);
	reranker.acquire();
	assert.strictEqual(workers.length, 1);
});

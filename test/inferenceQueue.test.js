const test = require("node:test");
const assert = require("node:assert");

const {InferenceQueue} = require("../dist/embedding/host/inferenceQueue.js");

/** A task that records when it starts and only finishes when released. */
function gated(log, name) {
	let release;
	const done = new Promise((resolve) => {
		release = resolve;
	});
	return {
		release: () => release(),
		run: async () => {
			log.push(`start:${name}`);
			await done;
			log.push(`end:${name}`);
			return name;
		},
	};
}

function tick() {
	return new Promise((resolve) => setImmediate(resolve));
}

test("an interactive task runs at the next boundary, ahead of queued background work", async () => {
	const log = [];
	const queue = new InferenceQueue();
	const b1 = gated(log, "b1");
	const b2 = gated(log, "b2");
	const q = gated(log, "q");

	const results = [queue.run("background", b1.run), queue.run("background", b2.run)];
	await tick();
	results.push(queue.run("interactive", q.run));

	b1.release();
	await tick();
	q.release();
	await tick();
	b2.release();

	assert.deepStrictEqual(await Promise.all(results), ["b1", "b2", "q"]);
	assert.deepStrictEqual(log, ["start:b1", "end:b1", "start:q", "end:q", "start:b2", "end:b2"]);
});

test("one inference at a time, never two", async () => {
	const log = [];
	const queue = new InferenceQueue();
	const a = gated(log, "a");
	const b = gated(log, "b");

	const done = Promise.all([queue.run("interactive", a.run), queue.run("interactive", b.run)]);
	await tick();
	assert.deepStrictEqual(log, ["start:a"]);

	a.release();
	b.release();
	await done;
	assert.deepStrictEqual(log, ["start:a", "end:a", "start:b", "end:b"]);
});

test("a failing task rejects alone and the queue keeps going", async () => {
	const queue = new InferenceQueue();

	const failing = queue.run("background", async () => {
		throw new Error("boom");
	});
	const next = queue.run("background", async () => "ok");

	await assert.rejects(failing, /boom/);
	assert.strictEqual(await next, "ok");
});

test("close waits for the running inference and rejects everything still waiting", async () => {
	const log = [];
	const queue = new InferenceQueue();
	const running = gated(log, "running");

	const first = queue.run("background", running.run);
	const waiting = queue.run("interactive", async () => "never");
	await tick();

	let closed = false;
	const closing = queue.close().then(() => {
		closed = true;
	});

	await assert.rejects(waiting, /disposed/);
	await tick();
	assert.strictEqual(closed, false, "the session is not torn down under a running inference");

	running.release();
	await closing;
	assert.strictEqual(await first, "running");
	await assert.rejects(queue.run("interactive", async () => "late"), /disposed/);
});

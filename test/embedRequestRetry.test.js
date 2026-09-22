const test = require("node:test");
const assert = require("node:assert");

/** Manual clock, so the 15s ack deadline and 5min work deadline are testable in milliseconds. */
function makeClock() {
	let now = 0;
	let seq = 0;
	const timers = new Map();

	async function flushMicrotasks() {
		await new Promise((resolve) => setImmediate(resolve));
	}

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
			const target = now + ms;
			for (;;) {
				let due = null;
				for (const [id, timer] of timers) {
					if (timer.at <= target && (due === null || timer.at < due.timer.at)) due = {id, timer};
				}
				if (!due) break;
				timers.delete(due.id);
				now = due.timer.at;
				due.timer.fn();
				await flushMicrotasks();
			}
			now = target;
			await flushMicrotasks();
		},
		flushMicrotasks,
	};
}

/**
 * @param respond called with each message the host posts into the worker, plus a `deliver`
 *   callback that plays a message back to the host the way the real worker would. A `type:
 *   'init'` message is answered with a `ready` response automatically, the way the worker
 *   acknowledges its own startup, unless `respond` intercepts it itself.
 */
function mountFakeWorker(respond) {
	const clock = makeClock();

	class FakeWorker {
		constructor() {
			this.listeners = {message: [], error: []};
		}

		postMessage(message) {
			if (message.type === 'init') {
				this.deliver({type: 'ready', device: 'wasm'});
				return;
			}
			respond(message, (data) => this.deliver(data));
		}

		addEventListener(type, fn) {
			this.listeners[type].push(fn);
		}

		removeEventListener(type, fn) {
			const list = this.listeners[type];
			const at = list.indexOf(fn);
			if (at >= 0) list.splice(at, 1);
		}

		deliver(data) {
			for (const listener of [...this.listeners.message]) listener({data});
		}

		terminate() {}
	}

	global.window = {
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		navigator: {onLine: true},
	};
	global.Worker = FakeWorker;
	global.Blob = class {};
	global.URL = {createObjectURL: () => 'blob:fake', revokeObjectURL: () => {}};

	return {clock};
}

const MODEL_CONFIG = {
	id: "xenova-paraphrase-multilingual-MiniLM-L12-v2",
	label: "Multilingual (slower)",
	repoId: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
	dim: 384,
	maxTokens: 128,
	pooling: "mean",
};

function loadMessenger() {
	const path = require.resolve("../dist/embedding/host/workerProvider.js");
	delete require.cache[path];
	return require(path).WorkerMessenger;
}

test("a request the worker has taken on is never sent a second time", async () => {
	const sent = [];
	let acked = 0;

	const {clock} = mountFakeWorker((message, deliver) => {
		sent.push(message);
		acked++;
		deliver({type: "ack", requestId: message.requestId});
		// ...and then never finishes, the way a very slow embedding on a phone behaves.
	});

	const WorkerMessenger = loadMessenger();
	const messenger = new WorkerMessenger("<script></script>", MODEL_CONFIG);
	await messenger.initialize();

	const embed = messenger.sendMessage("a long note", 15);
	const settled = embed.then(() => "resolved", (error) => error);

	// Past the ack deadline: acknowledged work must not be re-sent behind itself.
	await clock.advance(60_000);
	assert.strictEqual(acked, 1);
	assert.strictEqual(sent.filter((m) => m.type === 'embed').length, 1);

	// It still gives up eventually rather than hanging on to the request forever.
	await clock.advance(5 * 60_000);
	const outcome = await settled;
	assert.ok(outcome instanceof Error, `expected a rejection, got ${outcome}`);
	assert.match(outcome.message, /did not finish in time/);
	assert.strictEqual(sent.filter((m) => m.type === 'embed').length, 1);
});

test("a request the worker never acknowledges is retried", async () => {
	const sent = [];

	const {clock} = mountFakeWorker((message) => {
		sent.push(message);
		// Never acked: nothing received it.
	});

	const WorkerMessenger = loadMessenger();
	const messenger = new WorkerMessenger("<script></script>", MODEL_CONFIG);
	await messenger.initialize();

	const settled = messenger.sendMessage("a note", 15).then(() => "resolved", (error) => error);

	await clock.advance(3 * 15_000 + 1000);

	const outcome = await settled;
	assert.ok(outcome instanceof Error, `expected a rejection, got ${outcome}`);
	assert.match(outcome.message, /All 3 attempts/);
	assert.strictEqual(sent.filter((m) => m.type === 'embed').length, 3);
});

test("an acknowledged request still resolves with its result", async () => {
	const result = {chunks: [{embedding: [1, 2, 3], start: 0, end: 4}], metadata: {embeddingModelId: MODEL_CONFIG.id, maxOverlapPercent: 15}};

	mountFakeWorker((message, deliver) => {
		deliver({type: "ack", requestId: message.requestId});
		deliver({type: "embed-result", requestId: message.requestId, data: result});
	});

	const WorkerMessenger = loadMessenger();
	const messenger = new WorkerMessenger("<script></script>", MODEL_CONFIG);
	await messenger.initialize();

	const outcome = await messenger.sendMessage("a note", 15);
	assert.deepStrictEqual(outcome, result);
});

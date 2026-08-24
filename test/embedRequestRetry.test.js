const test = require("node:test");
const assert = require("node:assert");

const ORIGIN = "app://obsidian.md";

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
 * @param respond called with each message the host posts into the iframe, plus a `deliver`
 *   callback that plays a message back to the host the way the real iframe would.
 */
function mountFakeIframe(respond) {
	const clock = makeClock();
	const listeners = [];

	const contentWindow = {
		postMessage(message) {
			respond(message, deliver);
		},
	};
	const iframe = {contentWindow, remove() {}};

	function deliver(data) {
		for (const listener of [...listeners]) listener({origin: ORIGIN, source: contentWindow, data});
	}

	global.window = {
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		addEventListener(type, fn) {
			if (type === "message") listeners.push(fn);
		},
		removeEventListener(type, fn) {
			const at = listeners.indexOf(fn);
			if (at >= 0) listeners.splice(at, 1);
		},
		location: {origin: ORIGIN},
		origin: ORIGIN,
		navigator: {onLine: true},
	};
	global.document = {body: {createEl: () => iframe}};

	return {clock, deliver};
}

const MODEL_CONFIG = {
	id: "xenova-paraphrase-multilingual-MiniLM-L12-v2",
	label: "Multilingual (slower)",
	repoId: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
	dim: 384,
	maxTokens: 128,
	pooling: "mean",
};

const EMPTY_RESULT = {chunks: [], metadata: {embeddingModelId: MODEL_CONFIG.id, maxOverlapPercent: 0}};

function loadMessenger() {
	const path = require.resolve("../dist/embedding/host/messenger.js");
	delete require.cache[path];
	return require(path).IframeMessenger;
}

test("a request the iframe has taken on is never sent a second time", async () => {
	const sent = [];
	let acked = 0;

	const {clock} = mountFakeIframe((message, deliver) => {
		sent.push(message);
		if (message.payload === "ping") {
			deliver({requestId: message.requestId, data: EMPTY_RESULT});
			return;
		}
		acked++;
		deliver({type: "ack", requestId: message.requestId});
		// ...and then never finishes, the way a very slow embedding on a phone behaves.
	});

	const IframeMessenger = loadMessenger();
	const messenger = new IframeMessenger("test-iframe", "<script></script>", MODEL_CONFIG);
	await messenger.initialize();

	const embed = messenger.sendMessage("a long note", 15);
	const settled = embed.then(() => "resolved", (error) => error);

	// Past the delivery deadline: acknowledged work must not be re-sent behind itself.
	await clock.advance(60_000);
	assert.strictEqual(acked, 1);
	assert.strictEqual(sent.filter((m) => m.payload !== "ping").length, 1);

	// It still gives up eventually rather than hanging on to the request forever.
	await clock.advance(5 * 60_000);
	const outcome = await settled;
	assert.ok(outcome instanceof Error, `expected a rejection, got ${outcome}`);
	assert.match(outcome.message, /did not finish in time/);
	assert.strictEqual(sent.filter((m) => m.payload !== "ping").length, 1);
});

test("a request the iframe never acknowledges is retried", async () => {
	const sent = [];

	const {clock} = mountFakeIframe((message, deliver) => {
		sent.push(message);
		if (message.payload === "ping") deliver({requestId: message.requestId, data: EMPTY_RESULT});
		// Non-ping messages are dropped entirely: nothing received them.
	});

	const IframeMessenger = loadMessenger();
	const messenger = new IframeMessenger("test-iframe", "<script></script>", MODEL_CONFIG);
	await messenger.initialize();

	const settled = messenger.sendMessage("a note", 15).then(() => "resolved", (error) => error);

	await clock.advance(3 * 15_000 + 1000);

	const outcome = await settled;
	assert.ok(outcome instanceof Error, `expected a rejection, got ${outcome}`);
	assert.match(outcome.message, /All 3 attempts/);
	assert.strictEqual(sent.filter((m) => m.payload !== "ping").length, 3);
});

test("an acknowledged request still resolves with its result", async () => {
	const result = {
		chunks: [{embedding: [1, 2, 3], start: 0, end: 4}],
		metadata: {embeddingModelId: MODEL_CONFIG.id, maxOverlapPercent: 15},
	};

	const {clock} = mountFakeIframe((message, deliver) => {
		if (message.payload === "ping") {
			deliver({requestId: message.requestId, data: EMPTY_RESULT});
			return;
		}
		deliver({type: "ack", requestId: message.requestId});
		global.window.setTimeout(() => deliver({requestId: message.requestId, data: result}), 90_000);
	});

	const IframeMessenger = loadMessenger();
	const messenger = new IframeMessenger("test-iframe", "<script></script>", MODEL_CONFIG);
	await messenger.initialize();

	const embed = messenger.sendMessage("a long note", 15);
	await clock.advance(120_000);

	assert.deepStrictEqual(await embed, result);
});

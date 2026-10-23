const test = require("node:test");
const assert = require("node:assert");

global.window = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (id) => clearTimeout(id),
};

const {openIndex} = require("../dist/indexing/store/indexHandle.js");

const {EMBEDDING_MODEL} = require("../dist/constants.js");

const MODEL_ID = EMBEDDING_MODEL.id;
const DIM = 384;
const THROTTLE_MS = 10;

function vec(a, b) {
	const v = new Int8Array(DIM);
	v[0] = a;
	v[1] = b;
	return v;
}

function note(id, vectors = [vec(120, 10)]) {
	return {
		id,
		chunks: vectors.map((embedding, i) => ({
			embedding,
			start: i * 10,
			end: i * 10 + 5,
			hash: `h-${id}-${i}`,
		})),
		contentHash: `hash-${id}`,
		updatedAt: new Date(0).toISOString(),
	};
}

function makeFiles() {
	let meta = null;
	let binary = null;
	let writes = 0;
	let metaCorrupt = false;

	return {
		writeCount: () => writes,
		metaStore: {
			read: async () => {
				if (metaCorrupt) throw new Error("Unexpected token in JSON");
				return meta;
			},
			write: async (_modelId, data) => {
				meta = data;
				writes++;
			},
		},
		binaryStore: {
			read: async () => binary,
			write: async (_modelId, buffer) => {
				binary = buffer;
			},
		},
		corruptSidecar: () => {
			binary = new ArrayBuffer(8);
		},
		corruptMeta: () => {
			metaCorrupt = true;
		},
	};
}

async function openWith(files, ids = []) {
	const index = await openIndex(files, MODEL_ID, {throttleMs: THROTTLE_MS});
	for (const id of ids) index.upsert(note(id));
	if (ids.length > 0) await index.flush();
	return index;
}

test("bulk removal lands in a single write", async () => {
	const files = makeFiles();
	const index = await openWith(files, ["a.md", "b.md", "c.md"]);
	const before = files.writeCount();

	index.removeMany(["a.md", "b.md"]);
	await index.flush();

	assert.deepStrictEqual(index.ids(), ["c.md"]);
	assert.strictEqual(files.writeCount() - before, 1);
});

test("many separate mutations coalesce into one write", async () => {
	const files = makeFiles();
	const index = await openWith(files);
	const before = files.writeCount();

	for (let i = 0; i < 50; i++) index.upsert(note(`note-${i}.md`));
	await index.flush();

	assert.strictEqual(index.stats().notes, 50);
	assert.strictEqual(files.writeCount() - before, 1, "a burst of edits must not write once per note");
});

test("mutations that change nothing do not write", async () => {
	const files = makeFiles();
	const index = await openWith(files, ["a.md"]);
	const before = files.writeCount();

	assert.strictEqual(index.removeMany(["missing.md"]), false);
	assert.strictEqual(index.remove("missing.md"), false);
	assert.strictEqual(index.renameMany([{oldId: "missing.md", newId: "other.md"}]), false);
	assert.strictEqual(index.rename("a.md", "a.md"), false);
	await index.flush();

	assert.strictEqual(files.writeCount() - before, 0);
	assert.deepStrictEqual(index.ids(), ["a.md"]);
});

test("renaming keeps the note and its vectors under the new id", async () => {
	const files = makeFiles();
	const index = await openWith(files, ["a.md", "b.md"]);

	assert.strictEqual(index.rename("a.md", "renamed-a.md"), true);
	assert.strictEqual(index.renameMany([{oldId: "b.md", newId: "renamed-b.md"}]), true);
	await index.flush();

	assert.deepStrictEqual(index.ids().sort(), ["renamed-a.md", "renamed-b.md"]);
	assert.ok(index.get("renamed-a.md"), "renamed note must still be readable");
	assert.strictEqual(index.get("a.md"), null);
});

test("a failed write is retried on the next flush instead of being lost", async () => {
	const files = makeFiles();
	const index = await openWith(files);

	const write = files.metaStore.write;
	let failNext = true;
	files.metaStore.write = async (modelId, data) => {
		if (failNext) {
			failNext = false;
			throw new Error("disk full");
		}
		return write(modelId, data);
	};

	index.upsert(note("kept.md"));
	await assert.rejects(() => index.flush());

	await index.flush();
	const meta = await files.metaStore.read();
	assert.deepStrictEqual(meta.index.map((e) => e.id), ["kept.md"]);
});

test("an index survives a close and reopen", async () => {
	const files = makeFiles();
	const first = await openWith(files, ["a.md", "b.md"]);
	await first.close();

	const second = await openIndex(files, MODEL_ID, {throttleMs: THROTTLE_MS});

	assert.deepStrictEqual(second.ids().sort(), ["a.md", "b.md"]);
	assert.strictEqual(second.get("a.md").chunks[0].embedding[0], 120, "vectors must round-trip");
});

test("a note's quantization round-trips, and notes without one stay without one", async () => {
	const files = makeFiles();
	const first = await openIndex(files, MODEL_ID, {throttleMs: THROTTLE_MS});
	first.upsert({...note("new.md"), quant: {vocab: "q4", ffn: "fp32"}});
	first.upsert(note("legacy.md"));
	await first.close();

	const second = await openIndex(files, MODEL_ID, {throttleMs: THROTTLE_MS});

	assert.deepStrictEqual(second.get("new.md").quant, {vocab: "q4", ffn: "fp32"});
	assert.strictEqual(second.get("legacy.md").quant, undefined);
	assert.ok(!("quant" in second.get("legacy.md")), "legacy notes must not gain a quant key");
});

test("truncation round-trips, and notes indexed before it was recorded stay unknown", async () => {
	const files = makeFiles();
	const first = await openIndex(files, MODEL_ID, {throttleMs: THROTTLE_MS});
	first.upsert({...note("cut.md"), truncated: true});
	first.upsert({...note("whole.md"), truncated: false});
	first.upsert(note("legacy.md"));
	await first.close();

	const second = await openIndex(files, MODEL_ID, {throttleMs: THROTTLE_MS});

	assert.strictEqual(second.get("cut.md").truncated, true);
	assert.strictEqual(second.get("whole.md").truncated, false);
	assert.ok(!("truncated" in second.get("legacy.md")), "legacy notes must not gain a truncated key");
});

test("a corrupt sidecar is discarded rather than served", async () => {
	const files = makeFiles();
	const first = await openWith(files, ["a.md"]);
	await first.close();

	files.corruptSidecar();
	const second = await openIndex(files, MODEL_ID, {throttleMs: THROTTLE_MS});

	assert.strictEqual(second.isEmpty(), true);
});

test("a corrupt meta file is discarded rather than served, and does not crash openIndex", async () => {
	const files = makeFiles();
	const first = await openWith(files, ["a.md"]);
	await first.close();

	files.corruptMeta();
	const second = await openIndex(files, MODEL_ID, {throttleMs: THROTTLE_MS});

	assert.strictEqual(second.isEmpty(), true);
});

test("a genuinely fresh vault opens quietly, without eagerly writing empty files", async () => {
	const files = makeFiles();
	const index = await openIndex(files, MODEL_ID, {throttleMs: THROTTLE_MS});

	assert.strictEqual(index.isEmpty(), true);
	assert.strictEqual(files.writeCount(), 0, "a first-ever open must not write stub files to disk");
});

test("query ranks the closest note first and can exclude the query note", async () => {
	const files = makeFiles();
	const index = await openIndex(files, MODEL_ID, {throttleMs: THROTTLE_MS});

	index.upsert(note("self.md", [vec(127, 0)]));
	index.upsert(note("near.md", [vec(120, 40)]));
	index.upsert(note("far.md", [vec(0, 127)]));

	const results = index.query([vec(127, 0)], {excludeId: "self.md", minScore: 0});

	assert.strictEqual(results[0].id, "near.md");
	assert.ok(!results.some((r) => r.id === "self.md"), "the query note must be excluded");
});

test("query labels each result with the index model's tier and scaled score", async () => {
	const files = makeFiles();
	const index = await openIndex(files, MODEL_ID, {throttleMs: THROTTLE_MS});

	index.upsert(note("same.md", [vec(127, 0)]));
	index.upsert(note("loose.md", [vec(40, 120)]));

	const results = index.query([vec(127, 0)], {minScore: 0});
	const same = results.find((r) => r.id === "same.md");
	const loose = results.find((r) => r.id === "loose.md");

	assert.strictEqual(same.tier, 3);
	assert.ok(same.scaledScore > 0.999999);
	assert.strictEqual(loose.tier, 0);
	assert.ok(loose.scaledScore > 0 && loose.scaledScore < 0.25);
});

function fullRanking(index, noteId) {
	const {chunks} = index.get(noteId);
	return index.query(chunks.map((c) => c.embedding), {querySpans: chunks, excludeId: noteId, minScore: 0});
}

test("queryNote stays equal to a full ranking as the index changes underneath it", async () => {
	const files = makeFiles();
	const index = await openIndex(files, MODEL_ID, {throttleMs: THROTTLE_MS});

	index.upsert(note("self.md", [vec(127, 0), vec(90, 90)]));
	index.upsert(note("a.md", [vec(120, 40)]));
	index.upsert(note("b.md", [vec(0, 127)]));
	index.upsert(note("c.md", [vec(60, 100)]));

	const check = (label) => assert.deepStrictEqual(
		index.queryNote("self.md", {minScore: 0}),
		fullRanking(index, "self.md"),
		label,
	);

	check("initial ranking");
	index.upsert(note("d.md", [vec(127, 5)]));
	check("after a new note is indexed");
	index.upsert(note("a.md", [vec(5, 127)]));
	check("after a ranked note is re-indexed with different vectors");
	index.remove("d.md");
	check("after a ranked note is removed");
	index.rename("c.md", "renamed.md");
	check("after a note is renamed");
	index.upsert(note("self.md", [vec(0, 127)]));
	check("after the query note itself is re-indexed");

	assert.strictEqual(index.queryNote("missing.md"), null);
});

test("queryNote re-scores only notes whose vectors changed since the last query", async () => {
	const files = makeFiles();
	const index = await openIndex(files, MODEL_ID, {throttleMs: THROTTLE_MS});

	index.upsert(note("self.md", [vec(127, 0)]));
	const stale = note("stale.md", [vec(127, 0)]);
	index.upsert(stale);
	index.queryNote("self.md", {minScore: 0});

	// Stored notes are immutable by contract; mutating one in place reveals whether its cached score was reused.
	stale.chunks[0].embedding.set(vec(0, 127));
	index.upsert(note("new.md", [vec(127, 0)]));
	const cached = index.queryNote("self.md", {minScore: 0});
	assert.ok(cached.find((r) => r.id === "stale.md").score > 0.999999, "an unchanged note must not be re-scored");
	assert.ok(cached.find((r) => r.id === "new.md").score > 0.999999, "a newly indexed note must be scored");

	index.upsert({...stale, chunks: stale.chunks.slice()});
	const rescored = index.queryNote("self.md", {minScore: 0});
	assert.ok(rescored.find((r) => r.id === "stale.md").score < 0.5, "a re-indexed note must be re-scored");
});

test("a precise result carries the spans of both passages it matched on", async () => {
	const files = makeFiles();
	const index = await openIndex(files, MODEL_ID, {throttleMs: THROTTLE_MS});

	index.upsert(note("self.md", [vec(0, 127), vec(127, 0)]));
	index.upsert(note("other.md", [vec(0, -127), vec(127, 5), vec(-60, -100)]));

	const self = index.get("self.md").chunks;
	const fromText = index.query(self.map((c) => c.embedding), {querySpans: self, excludeId: "self.md", minScore: -Infinity});
	for (const results of [fromText, index.queryNote("self.md", {minScore: -Infinity})]) {
		const other = results.find((r) => r.id === "other.md");
		assert.strictEqual(other.match, "precise");
		assert.deepStrictEqual(other.passage, {start: 10, end: 15, hash: "h-other.md-1"});
		assert.deepStrictEqual(other.queryPassage, {start: 10, end: 15, hash: "h-self.md-1"});
	}
});

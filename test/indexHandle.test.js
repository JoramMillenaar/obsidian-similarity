const test = require("node:test");
const assert = require("node:assert");

global.window = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (id) => clearTimeout(id),
};

const {openIndex} = require("../dist/indexing/store/indexHandle.js");

const MODEL_ID = "xenova-all-MiniLM-L6-v2";
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

	index.removeMany(["missing.md"]);
	index.renameMany([{oldId: "missing.md", newId: "other.md"}]);
	index.rename("a.md", "a.md");
	await index.flush();

	assert.strictEqual(files.writeCount() - before, 0);
	assert.deepStrictEqual(index.ids(), ["a.md"]);
});

test("renaming keeps the note and its vectors under the new id", async () => {
	const files = makeFiles();
	const index = await openWith(files, ["a.md", "b.md"]);

	index.rename("a.md", "renamed-a.md");
	index.renameMany([{oldId: "b.md", newId: "renamed-b.md"}]);
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

const test = require("node:test");
const assert = require("node:assert");

const {resolveSimilarNotesForNote} = require("../dist/search/resolveSimilarNotes.js");
const {makeGetSimilarNotesForNote} = require("../dist/search/getSimilarNotesForNote.js");
const {makeIndexNote} = require("../dist/app/indexNote.js");
const {hashText} = require("../dist/core/text/hash.js");

const READY = {kind: "ready", modelId: "m", device: "webgpu"};
const IDLE_INDEXING = {isRunning: false, pending: 0, processed: 0, total: 0, failed: 0, failedIds: []};

function makeResolveDeps({ignored = false, truncated = true} = {}) {
	let calls = 0;
	return {
		deps: {
			statusHub: {getEngineState: () => READY, getIndexingState: () => IDLE_INDEXING},
			getSimilarNotesForNote: async () => {
				calls += 1;
				return {items: [], truncated};
			},
			isIndexEmpty: async () => false,
			isIgnoredPath: () => ignored,
		},
		calls: () => calls,
	};
}

test("a searched note reports whether it was truncated", async () => {
	const {deps} = makeResolveDeps({truncated: true});
	assert.strictEqual((await resolveSimilarNotesForNote(deps, "a.md")).truncated, true);
});

test("an ignored note is never reported as truncated or even searched", async () => {
	const {deps, calls} = makeResolveDeps({ignored: true});
	const result = await resolveSimilarNotesForNote(deps, "a.md");
	assert.strictEqual(result.notice.kind, "ignored-path");
	assert.notStrictEqual(result.truncated, true);
	assert.strictEqual(calls(), 0);
});

test("an unsupported file is never reported as truncated or even searched", async () => {
	const {deps, calls} = makeResolveDeps();
	const result = await resolveSimilarNotesForNote(deps, "a.png");
	assert.strictEqual(result.notice.kind, "unsupported-file");
	assert.notStrictEqual(result.truncated, true);
	assert.strictEqual(calls(), 0);
});

function searchWith(indexed) {
	return makeGetSimilarNotesForNote({
		index: {get: () => indexed, query: () => []},
	})({noteId: "a.md"});
}

test("truncation is read from the searched note's index entry", async () => {
	assert.strictEqual((await searchWith({chunks: [], truncated: true})).truncated, true);
	assert.strictEqual((await searchWith({chunks: [], truncated: false})).truncated, false);
});

test("an entry from before truncation was recorded, and an unindexed note, read as not truncated", async () => {
	assert.strictEqual((await searchWith({chunks: []})).truncated, false);
	assert.strictEqual((await searchWith(null)).truncated, false);
});

function setupIndexNote({existing, truncated}) {
	const upserts = [];
	let embeds = 0;
	const indexNote = makeIndexNote({
		getNoteText: async () => ({text: "same text", truncated}),
		index: {
			modelId: "m",
			get: () => existing,
			remove() {},
			upsert: (note) => upserts.push(note),
		},
		isIgnoredPath: () => false,
		embedText: async () => {
			embeds += 1;
			return {
				chunks: [{embedding: new Int8Array(1), start: 0, end: 4}],
				metadata: {embeddingModelId: "m", quant: {vocab: "q4", ffn: "fp16"}},
			};
		},
	});
	return {indexNote, upserts, embeds: () => embeds};
}

test("indexing records whether the note was truncated", async () => {
	const {indexNote, upserts} = setupIndexNote({existing: null, truncated: true});
	assert.strictEqual(await indexNote("a.md"), "indexed");
	assert.strictEqual(upserts[0].truncated, true);
});

test("re-visiting an unchanged legacy entry backfills truncation without re-embedding", async () => {
	const chunks = [{embedding: new Int8Array([7]), start: 0, end: 9, hash: "c"}];
	const existing = {id: "a.md", chunks, contentHash: hashText("same text"), updatedAt: "x"};
	const {indexNote, upserts, embeds} = setupIndexNote({existing, truncated: false});

	assert.strictEqual(await indexNote("a.md"), "unchanged");
	assert.strictEqual(embeds(), 0);
	assert.deepStrictEqual(upserts, [{...existing, truncated: false}]);
	assert.strictEqual(upserts[0].chunks, chunks, "vectors must be kept as-is");
});

test("an unchanged entry that already knows its truncation is left alone", async () => {
	const existing = {id: "a.md", chunks: [], contentHash: hashText("same text"), updatedAt: "x", truncated: true};
	const {indexNote, upserts, embeds} = setupIndexNote({existing, truncated: true});

	assert.strictEqual(await indexNote("a.md"), "unchanged");
	assert.strictEqual(embeds(), 0);
	assert.strictEqual(upserts.length, 0);
});

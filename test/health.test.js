const test = require("node:test");
const assert = require("node:assert");

const {checkIndexHealth} = require("../dist/core/rules/health.js");

const DIM = 4;
const SCHEMA_VERSION = 2; // must track src/types.ts SCHEMA_VERSION

function okSidecar(count, dim = DIM) {
	return {status: "ok", dim, count, byteLength: 16 + count * dim};
}

function okMeta(index, overrides = {}) {
	return {status: "ok", data: {schemaVersion: SCHEMA_VERSION, embeddingDim: DIM, index, ...overrides}};
}

function entry(id, rows, overrides = {}) {
	return {
		id,
		contentHash: `hash-${id}`,
		updatedAt: new Date(0).toISOString(),
		chunks: rows.map((row, i) => ({row, start: i * 10, end: i * 10 + 5, hash: `h-${id}-${i}`})),
		...overrides,
	};
}

function healthy(entries, sidecarCount) {
	return checkIndexHealth({
		meta: okMeta(entries),
		sidecar: okSidecar(sidecarCount),
	});
}

test("a consistent meta/sidecar pair is fully healthy", () => {
	const result = healthy([entry("a.md", [0]), entry("b.md", [1, 2])], 3);

	assert.strictEqual(result.status, "checked");
	assert.strictEqual(result.droppedIds.length, 0);
	assert.strictEqual(result.validEntries.length, 2);
});

test("an empty index is healthy even with an empty sidecar", () => {
	const result = healthy([], 0);
	assert.deepStrictEqual(result, {status: "checked", validEntries: [], droppedIds: []});
});

// Regression coverage for the case found reviewing indexHandle.ts: writeNow
// writes the binary and meta files as two separate awaited calls. If the
// process dies between them, every row after the point of change is silently
// reassigned to a different note's vector — and each individual row still
// looks valid (in range, uncontested), so per-row validation alone lets it
// through. Only a total-count mismatch reveals the two files disagree about
// the note set as a whole.
test("a torn write is caught even when every row is individually in-range and uncontested", () => {
	// Binary was written for {a: 1 row, b: 1 row, c: 1 row} = 3 rows, but the
	// meta write that landed still describes the prior set with only 2 rows
	// claimed. Both entries below reference rows 0 and 1 — both in range,
	// no collisions — yet they no longer describe the actual binary layout.
	const result = healthy([entry("a.md", [0]), entry("b.md", [1])], 3);

	assert.strictEqual(result.status, "unusable");
	assert.strictEqual(result.reason, "row-count-mismatch");
});

test("a torn write is caught when meta claims more rows than the sidecar holds", () => {
	const result = healthy([entry("a.md", [0]), entry("b.md", [1, 2])], 2);

	assert.strictEqual(result.status, "unusable");
	assert.strictEqual(result.reason, "row-count-mismatch");
});

test("a malformed entry mixed with valid ones is still dropped individually when counts agree", () => {
	// countClaimedRows counts the malformed entry's chunks array as-is (it has
	// one element), so the total still lines up with the sidecar; the entry is
	// then rejected in the per-entry pass for its empty id, same as before this
	// change.
	const malformed = entry("", [0]);
	const result = healthy([malformed, entry("b.md", [1])], 2);

	assert.strictEqual(result.status, "checked");
	assert.deepStrictEqual(result.droppedIds, ["<unknown>"]);
	assert.deepStrictEqual(result.validEntries.map((e) => e.id), ["b.md"]);
});

test("legacy schema is unusable regardless of row counts", () => {
	const result = checkIndexHealth({
		meta: okMeta([entry("a.md", [0])], {schemaVersion: 1}),
		sidecar: okSidecar(1),
	});

	assert.deepStrictEqual(result, {status: "unusable", reason: "legacy-schema"});
});

test("a missing sidecar is unusable when entries exist", () => {
	const result = checkIndexHealth({
		meta: okMeta([entry("a.md", [0])]),
		sidecar: {status: "missing"},
	});

	assert.deepStrictEqual(result, {status: "unusable", reason: "missing-sidecar"});
});

test("a corrupt sidecar is unusable when entries exist", () => {
	const result = checkIndexHealth({
		meta: okMeta([entry("a.md", [0])]),
		sidecar: {status: "corrupt"},
	});

	assert.deepStrictEqual(result, {status: "unusable", reason: "corrupt-sidecar"});
});

test("a dimension mismatch is unusable, checked before row counts", () => {
	const result = checkIndexHealth({
		meta: okMeta([entry("a.md", [0])]),
		sidecar: okSidecar(1, DIM + 1),
	});

	assert.deepStrictEqual(result, {status: "unusable", reason: "dim-mismatch"});
});

test("an invalid binary layout is unusable, checked before row counts", () => {
	const result = checkIndexHealth({
		meta: okMeta([entry("a.md", [0])]),
		sidecar: {status: "ok", dim: DIM, count: 1, byteLength: 3},
	});

	assert.deepStrictEqual(result, {status: "unusable", reason: "layout-invalid"});
});

// --- meta-side coverage added for step 2 of the hardening plan ---
//
// Before this step, openIndex read the meta file with `files.metaStore.read()`,
// which swallowed a JSON.parse failure to `null` — identical to "file doesn't
// exist". checkIndexHealth then defaulted a missing/unreadable meta's
// schemaVersion to 1, which is always < SCHEMA_VERSION, so:
//   (a) a vault that had never been indexed logged a misleading
//       "Index discarded (legacy-schema)" warning on every first run, and
//   (b) a genuinely corrupt meta file was indistinguishable from a fresh one,
//       hiding a real repair signal behind a routine one.
// MetaState now carries missing/corrupt/ok explicitly, mirroring SidecarState.

test("a genuinely fresh vault (no meta, no sidecar) is healthy, not discarded", () => {
	const result = checkIndexHealth({
		meta: {status: "missing"},
		sidecar: {status: "missing"},
	});

	assert.deepStrictEqual(result, {status: "checked", validEntries: [], droppedIds: []});
});

test("meta missing but a sidecar file exists is unusable, not treated as fresh", () => {
	// An inconsistent state (e.g. the meta write of a torn write never landed
	// at all) — the binary can't be interpreted without meta describing it.
	const result = checkIndexHealth({
		meta: {status: "missing"},
		sidecar: okSidecar(1),
	});

	assert.deepStrictEqual(result, {status: "unusable", reason: "missing-meta"});
});

test("corrupt meta is unusable and distinct from a missing file, even with no sidecar", () => {
	const result = checkIndexHealth({
		meta: {status: "corrupt"},
		sidecar: {status: "missing"},
	});

	assert.deepStrictEqual(result, {status: "unusable", reason: "corrupt-meta"});
});

test("corrupt meta is unusable even when the sidecar looks fine", () => {
	const result = checkIndexHealth({
		meta: {status: "corrupt"},
		sidecar: okSidecar(1),
	});

	assert.deepStrictEqual(result, {status: "unusable", reason: "corrupt-meta"});
});

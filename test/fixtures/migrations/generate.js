/*
 * Dev convenience only — regenerates the frozen migration fixtures from the
 * canonical spec below. The COMMITTED files are the source of truth; CI never
 * runs this. Re-run by hand (`npm run build && node test/fixtures/migrations/generate.js`)
 * only when intentionally authoring a new fixture, then review the diff.
 *
 * expected.json is written straight from the spec — NOT from the pack/unpack
 * code under test — so the migration test compares production output against an
 * independent expectation.
 */
// Guard: only ever write fixtures when run directly (`node .../generate.js`).
// The test runner globs *.test.js and never imports this file, but this keeps
// it inert as a plain module regardless, so a test run can never rewrite the
// frozen fixtures.
if (require.main !== module) {
	module.exports = {};
	return;
}

const fs = require("fs");
const path = require("path");
const {packIndexedNotesToV2} = require("../../../dist/domain/migrateEmbeddingStore.js");
const {encodeEmbeddings} = require("../../../dist/domain/embeddingCodec.js");

const HERE = __dirname;
const DIM = 4;

// Canonical notes. Embeddings are L2-normalized (components in [-1, 1]) because
// the sidecar stores symmetric int8 — that's the shape real embeddings have.
const SPEC = [
	{id: "notes/alpha.md", contentHash: "aaaa1111", updatedAt: "2026-01-01T00:00:00.000Z", embedding: [1, 0, 0, 0]},
	{id: "notes/beta.md", contentHash: "bbbb2222", updatedAt: "2026-02-02T00:00:00.000Z", embedding: [0.5, 0.5, 0.5, 0.5]},
	{id: "notes/gamma.md", contentHash: "cccc3333", updatedAt: "2026-03-03T00:00:00.000Z", embedding: [0.6, 0, 0.8, 0]},
];

// Partial legacy settings WITHOUT initialIndexCompleted, so migrating a populated
// v1 vault exercises normalizePluginData's backfill (flag -> true).
const LEGACY_SETTINGS = {ignoredPaths: ["templates/"]};

function writeJson(dir, name, value) {
	fs.mkdirSync(path.join(HERE, dir), {recursive: true});
	fs.writeFileSync(path.join(HERE, dir, name), JSON.stringify(value, null, "\t") + "\n");
}

function writeBin(dir, name, buffer) {
	fs.mkdirSync(path.join(HERE, dir), {recursive: true});
	fs.writeFileSync(path.join(HERE, dir, name), Buffer.from(buffer));
}

// Independent expectation, straight from the spec (sorted by id like packIndexedNotesToV2).
const expected = {
	embeddingDim: DIM,
	notes: [...SPEC].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
};

// --- v1: legacy on-disk shape (inline float embeddings, no schemaVersion/embeddingDim) ---
writeJson("v1", "data.json", {
	settings: LEGACY_SETTINGS,
	index: SPEC.map((n) => ({id: n.id, embedding: n.embedding, contentHash: n.contentHash, updatedAt: n.updatedAt})),
});
writeJson("v1", "expected.json", expected);

// --- v2: current on-disk shape (slim JSON index + int8 sidecar) ---
const packed = packIndexedNotesToV2(SPEC);
const v2Data = {
	settings: {...LEGACY_SETTINGS, initialIndexCompleted: true},
	schemaVersion: 2,
	embeddingDim: packed.dim,
	index: packed.index,
};
writeJson("v2", "data.json", v2Data);
writeBin("v2", "embeddings.bin", encodeEmbeddings(packed.embeddings, packed.dim));
writeJson("v2", "expected.json", expected);

// --- failure-mode fixtures: v2 JSON whose sidecar can't back it ---
// Missing sidecar (no embeddings.bin written at all).
writeJson("v2-missing-bin", "data.json", v2Data);
// Corrupt sidecar (garbage bytes -> bad magic).
writeJson("v2-corrupt-bin", "data.json", v2Data);
writeBin("v2-corrupt-bin", "embeddings.bin", new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]).buffer);

console.log("Regenerated migration fixtures under", HERE);

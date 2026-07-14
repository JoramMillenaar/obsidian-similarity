/*
 * Protects the storage-migration invariant: a vault sitting on ANY older
 * on-disk schema version must, under current code, load and migrate up to the
 * current shape with its notes intact — for every version, forever.
 *
 * Each test/fixtures/migrations/v<N>/ directory is a FROZEN snapshot of a real
 * on-disk vault at schema version N (data.json [+ embeddings.bin]) plus an
 * independently-authored expected.json. We run the REAL production migration
 * flow (makeMigrateStore -> ObsidianPluginDataIndexStorage.rewrite/getAll)
 * against in-memory stand-ins for the two I/O leaves and assert the result.
 *
 * The "version guard" test at the bottom fails the moment SCHEMA_VERSION is
 * bumped without adding a fixture for the previous version — forcing every new
 * migration to ship with proof that an old vault still loads.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const {ObsidianPluginDataIndexStorage} = require("../dist/infra/obsidian/obsidianStorage.js");
const {makeMigrateStore} = require("../dist/app/makeMigrateStore.js");
const {SCHEMA_VERSION} = require("../dist/types.js");
const {InMemoryPluginDataStore, InMemoryEmbeddingFileStore} = require("./helpers/inMemoryStores.js");

const FIXTURES = path.join(__dirname, "fixtures", "migrations");

// Max round error of symmetric int8 quantization (q = round(x * 127) / 127).
const EMBEDDING_TOLERANCE = 1 / 127;

function readJson(dir, name) {
	return JSON.parse(fs.readFileSync(path.join(FIXTURES, dir, name), "utf8"));
}

/** Reads a fixture's embeddings.bin as an ArrayBuffer, or null if absent. */
function readBin(dir) {
	const file = path.join(FIXTURES, dir, "embeddings.bin");
	if (!fs.existsSync(file)) return null;
	const buf = fs.readFileSync(file);
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** Wires the real storage adapter over in-memory stores seeded from a fixture. */
function loadFixture(dir) {
	const dataStore = new InMemoryPluginDataStore(readJson(dir, "data.json"));
	const binStore = new InMemoryEmbeddingFileStore(readBin(dir));
	const storage = new ObsidianPluginDataIndexStorage(dataStore, binStore);
	return {dataStore, binStore, storage};
}

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function assertNotesMatch(actual, expectedNotes) {
	const got = [...actual].sort(byId);
	const want = [...expectedNotes].sort(byId);
	assert.strictEqual(got.length, want.length, "note count");
	for (let i = 0; i < want.length; i++) {
		assert.strictEqual(got[i].id, want[i].id, "id");
		assert.strictEqual(got[i].contentHash, want[i].contentHash, `contentHash for ${want[i].id}`);
		assert.strictEqual(got[i].updatedAt, want[i].updatedAt, `updatedAt for ${want[i].id}`);
		assert.strictEqual(got[i].embedding.length, want[i].embedding.length, `embedding length for ${want[i].id}`);
		for (let j = 0; j < want[i].embedding.length; j++) {
			const delta = Math.abs(got[i].embedding[j] - want[i].embedding[j]);
			assert.ok(
				delta <= EMBEDDING_TOLERANCE,
				`embedding[${j}] for ${want[i].id}: got ${got[i].embedding[j]}, want ~${want[i].embedding[j]} (delta ${delta})`,
			);
		}
	}
}

/** Every versioned fixture directory (v1, v2, ...), sorted ascending. */
function versionedFixtureDirs() {
	return fs.readdirSync(FIXTURES, {withFileTypes: true})
		.filter((e) => e.isDirectory() && /^v\d+$/.test(e.name))
		.map((e) => e.name)
		.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

// ---------------------------------------------------------------------------
// Per-version round-trip: every historical vault migrates to the current shape.
// ---------------------------------------------------------------------------
for (const dir of versionedFixtureDirs()) {
	const expected = readJson(dir, "expected.json");

	test(`${dir}: migrates to the current shape with notes intact`, async () => {
		const {dataStore, storage} = loadFixture(dir);

		await makeMigrateStore({indexStorage: storage})();

		assertNotesMatch(await storage.getAll(), expected.notes);

		const persisted = await dataStore.read();
		assert.strictEqual(persisted.schemaVersion, SCHEMA_VERSION, "schemaVersion is current");
		assert.strictEqual(persisted.embeddingDim, expected.embeddingDim, "embeddingDim");
		assert.strictEqual(await storage.needsRebuild(), false, "no rebuild needed");
		assert.strictEqual(await storage.isEmpty(), false, "index reports populated");
	});

	test(`${dir}: migration is idempotent`, async () => {
		const {storage} = loadFixture(dir);

		const migrate = makeMigrateStore({indexStorage: storage});
		await migrate();
		const once = await storage.getAll();
		await migrate();
		const twice = await storage.getAll();

		assertNotesMatch(twice, once);
	});
}

// A populated legacy vault with no initialIndexCompleted flag must come out of
// migration with the flag backfilled, so the plugin doesn't re-run the initial
// index over an already-indexed vault.
test("v1: legacy populated vault backfills initialIndexCompleted", async () => {
	const {dataStore, storage} = loadFixture("v1");

	await makeMigrateStore({indexStorage: storage})();

	const persisted = await dataStore.read();
	assert.strictEqual(persisted.settings.initialIndexCompleted, true);
});

// ---------------------------------------------------------------------------
// Failure modes: v2 JSON whose sidecar can't back it must ask for a rebuild
// rather than silently serving an empty or wrong index.
// ---------------------------------------------------------------------------
test("v2 with a missing sidecar needs a rebuild and serves nothing", async () => {
	const {storage} = loadFixture("v2-missing-bin");

	assert.strictEqual(await storage.needsRebuild(), true);
	assert.deepStrictEqual(await storage.getAll(), []);
	assert.strictEqual(await storage.isEmpty(), true);
});

test("v2 with a corrupt sidecar needs a rebuild and serves nothing", async () => {
	const {storage} = loadFixture("v2-corrupt-bin");

	assert.strictEqual(await storage.needsRebuild(), true);
	assert.deepStrictEqual(await storage.getAll(), []);
	assert.strictEqual(await storage.isEmpty(), true);
});

// ---------------------------------------------------------------------------
// Version guard — the "forever" mechanism. Bumping SCHEMA_VERSION without
// adding a fixture for the now-legacy version fails here.
// ---------------------------------------------------------------------------
test("a migration fixture exists for every schema version up to the current one", () => {
	const present = new Set(versionedFixtureDirs().map((d) => Number(d.slice(1))));
	const missing = [];
	for (let v = 1; v <= SCHEMA_VERSION; v++) {
		if (!present.has(v)) missing.push(`v${v}`);
	}
	assert.deepStrictEqual(
		missing,
		[],
		`Missing migration fixture(s) ${missing.join(", ")} for SCHEMA_VERSION=${SCHEMA_VERSION}. `
		+ `Add test/fixtures/migrations/<version>/ proving a vault at that version still loads.`,
	);
});

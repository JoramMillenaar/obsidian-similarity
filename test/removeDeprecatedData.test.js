const test = require("node:test");
const assert = require("node:assert");

const {makeRemoveDeprecatedData} = require("../dist/app/removeDeprecatedData.js");
const {DEPRECATED_MODEL_IDS, EMBEDDING_MODEL} = require("../dist/constants.js");

function fileStore(ids) {
	const present = new Set(ids);
	return {
		present,
		remove: async (id) => present.delete(id),
	};
}

function setup(raw, {present = [], legacyFile = false} = {}) {
	const written = [];
	let legacy = legacyFile;
	const deps = {
		pluginDataStore: {readRaw: async () => raw, write: async (data) => written.push(data)},
		modelIndexStore: fileStore(present),
		embeddingFileStore: fileStore(present),
		legacyEmbeddingFileStore: {
			remove: async () => {
				const had = legacy;
				legacy = false;
				return had;
			},
		},
	};
	return {deps, written, hasLegacyFile: () => legacy};
}

test("every deprecated index is removed, and the current one is left alone", async () => {
	const {deps} = setup({settings: {}}, {present: [...DEPRECATED_MODEL_IDS, EMBEDDING_MODEL.id]});

	await makeRemoveDeprecatedData(deps)();

	assert.deepStrictEqual([...deps.modelIndexStore.present], [EMBEDDING_MODEL.id]);
	assert.deepStrictEqual([...deps.embeddingFileStore.present], [EMBEDDING_MODEL.id]);
});

test("a pre-v2 index is dropped, not migrated: it only ever held the deprecated English model", async () => {
	const raw = {schemaVersion: 2, embeddingDim: 384, index: [{id: "a.md"}], settings: {ignoredPaths: ["Private"]}};
	const {deps, written, hasLegacyFile} = setup(raw, {legacyFile: true});

	await makeRemoveDeprecatedData(deps)();

	assert.strictEqual(hasLegacyFile(), false, "embeddings.bin is gone");
	assert.deepStrictEqual(Object.keys(written[0]), ["settings"], "data.json keeps only settings");
	assert.deepStrictEqual(written[0].settings.ignoredPaths, ["Private"]);
});

test("up-to-date data is not rewritten", async () => {
	const {deps, written} = setup({settings: {ignoredPaths: []}});
	await makeRemoveDeprecatedData(deps)();
	assert.strictEqual(written.length, 0);
});

test("a removal that fails does not stop the others, or the plugin from starting", async () => {
	const {deps} = setup({settings: {}}, {present: [...DEPRECATED_MODEL_IDS]});
	const [failing] = DEPRECATED_MODEL_IDS;
	const remove = deps.modelIndexStore.remove;
	deps.modelIndexStore.remove = async (id) => {
		if (id === failing) throw new Error("EBUSY");
		return remove(id);
	};
	const warn = console.warn;
	console.warn = () => {};
	try {
		await makeRemoveDeprecatedData(deps)();
	} finally {
		console.warn = warn;
	}

	assert.deepStrictEqual([...deps.modelIndexStore.present], [failing], "retried on the next start");
	assert.deepStrictEqual([...deps.embeddingFileStore.present], [failing]);
});

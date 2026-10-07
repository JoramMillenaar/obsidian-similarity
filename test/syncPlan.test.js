const test = require("node:test");
const assert = require("node:assert");

const {makeBuildIndexSyncPlan} = require("../dist/indexing/syncPlan.js");

const BASE_SETTINGS = {
	ignoredPaths: [],
	maxRawMarkdownChars: 20000,
	maxExtractedChars: 4800,
	lastAppliedMaxRawMarkdownChars: 20000,
	lastAppliedMaxExtractedChars: 4800,
};

function makePlan({settings, candidates, entries}) {
	return makeBuildIndexSyncPlan({
		vault: {listIndexCandidates: () => candidates},
		index: {entries: () => entries},
		settingsRepo: {get: () => settings},
	})();
}

test("an unmodified, untruncated note stays out of the sync plan when caps are unchanged", () => {
	const plan = makePlan({
		settings: BASE_SETTINGS,
		candidates: [{id: "a.md", modifiedAt: 100}],
		entries: [{id: "a.md", updatedAt: new Date(100).toISOString(), contentHash: "h", truncated: false}],
	});
	assert.deepStrictEqual(plan.idsToSeed, []);
});

test("an entry from before truncation was recorded is queued so the flag gets filled in", () => {
	const plan = makePlan({
		settings: BASE_SETTINGS,
		candidates: [{id: "old.md", modifiedAt: 100}, {id: "new.md", modifiedAt: 100}],
		entries: [
			{id: "old.md", updatedAt: new Date(100).toISOString(), contentHash: "h"},
			{id: "new.md", updatedAt: new Date(100).toISOString(), contentHash: "h", truncated: false},
		],
	});
	assert.deepStrictEqual(plan.idsToSeed, ["old.md"]);
});

test("a note edited after indexing is still caught by the mtime check", () => {
	const plan = makePlan({
		settings: BASE_SETTINGS,
		candidates: [{id: "a.md", modifiedAt: 200}],
		entries: [{id: "a.md", updatedAt: new Date(100).toISOString(), contentHash: "h", truncated: false}],
	});
	assert.deepStrictEqual(plan.idsToSeed, ["a.md"]);
});

test("raising maxExtractedChars re-seeds a note that was truncated at the old cap", () => {
	const settings = {...BASE_SETTINGS, maxExtractedChars: 8000};
	const plan = makePlan({
		settings,
		candidates: [{id: "long.md", modifiedAt: 100}],
		entries: [{id: "long.md", updatedAt: new Date(100).toISOString(), contentHash: "h", truncated: true}],
	});
	assert.deepStrictEqual(plan.idsToSeed, ["long.md"]);
});

test("raising maxExtractedChars does not re-seed a note that was not truncated", () => {
	const settings = {...BASE_SETTINGS, maxExtractedChars: 8000};
	const plan = makePlan({
		settings,
		candidates: [{id: "short.md", modifiedAt: 100}],
		entries: [{id: "short.md", updatedAt: new Date(100).toISOString(), contentHash: "h", truncated: false}],
	});
	assert.deepStrictEqual(plan.idsToSeed, []);
});

test("lowering a cap never re-seeds unmodified notes", () => {
	const settings = {...BASE_SETTINGS, maxExtractedChars: 1000};
	const plan = makePlan({
		settings,
		candidates: [{id: "long.md", modifiedAt: 100}],
		entries: [{id: "long.md", updatedAt: new Date(100).toISOString(), contentHash: "h", truncated: true}],
	});
	assert.deepStrictEqual(plan.idsToSeed, []);
});

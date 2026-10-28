const test = require("node:test");
const assert = require("node:assert");

const {normalizeSettings} = require("../dist/core/rules/schema.js");

test("a custom character cap is preserved", () => {
	assert.strictEqual(normalizeSettings({maxRawMarkdownChars: 50000}).maxRawMarkdownChars, 50000);
	assert.strictEqual(normalizeSettings({maxRawMarkdownChars: 20000}).maxRawMarkdownChars, 20000);
});

test("older settings drop the extracted cap and count it as last applied", () => {
	const settings = normalizeSettings({
		maxRawMarkdownChars: 20000,
		maxExtractedChars: 4800,
		lastAppliedMaxRawMarkdownChars: 20000,
		lastAppliedMaxExtractedChars: 4800,
	});
	assert.strictEqual(settings.maxRawMarkdownChars, 20000);
	assert.strictEqual(settings.lastAppliedMaxRawMarkdownChars, 4800, "notes cut at 4800 get re-indexed");
	assert.ok(!("maxExtractedChars" in settings));
	assert.ok(!("lastAppliedMaxExtractedChars" in settings));
});

test("a customized older cap is kept", () => {
	const settings = normalizeSettings({
		maxRawMarkdownChars: 30000,
		maxExtractedChars: 9000,
		lastAppliedMaxRawMarkdownChars: 30000,
		lastAppliedMaxExtractedChars: 9000,
	});
	assert.strictEqual(settings.maxRawMarkdownChars, 30000);
	assert.strictEqual(settings.lastAppliedMaxRawMarkdownChars, 9000);
});

test("removed settings are dropped", () => {
	const settings = normalizeSettings({
		showDates: false,
		searchMode: "average",
		embeddingModelId: "xenova-all-MiniLM-L6-v2",
		maxOverlapPercent: 30,
	});
	for (const key of ["showDates", "searchMode", "embeddingModelId", "maxOverlapPercent"]) {
		assert.ok(!(key in settings), `${key} is dropped`);
	}
});

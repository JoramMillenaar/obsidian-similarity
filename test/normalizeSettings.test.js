const test = require("node:test");
const assert = require("node:assert");

const {normalizeSettings} = require("../dist/core/rules/schema.js");

test("custom character caps are preserved", () => {
	const settings = normalizeSettings({maxRawMarkdownChars: 50000, maxExtractedChars: 9000});
	assert.strictEqual(settings.maxRawMarkdownChars, 50000);
	assert.strictEqual(settings.maxExtractedChars, 9000);
});

test("a stored showDates value is dropped", () => {
	assert.ok(!("showDates" in normalizeSettings({showDates: false})));
});

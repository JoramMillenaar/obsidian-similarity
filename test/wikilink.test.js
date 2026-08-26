const test = require("node:test");
const assert = require("node:assert");
const {
	formatWikilink,
	getWikilinkTarget,
	stripMarkdownExtension,
} = require("../dist/core/text/wikilink.js");

test("stripMarkdownExtension removes only the markdown suffix", () => {
	assert.strictEqual(stripMarkdownExtension("test.md"), "test");
	assert.strictEqual(stripMarkdownExtension("dir/test.md"), "dir/test");
	assert.strictEqual(stripMarkdownExtension("dir/test"), "dir/test");
});

test("getWikilinkTarget uses basename when it is unique", () => {
	assert.strictEqual(getWikilinkTarget("test.md", ["test.md", "other.md"]), "test");
	assert.strictEqual(getWikilinkTarget("dir/test.md", ["dir/test.md", "other.md"]), "test");
});

test("getWikilinkTarget preserves folder paths for duplicate note names", () => {
	assert.strictEqual(getWikilinkTarget("test.md", ["test.md", "dir/test.md"]), "test");
	assert.strictEqual(getWikilinkTarget("dir/test.md", ["test.md", "dir/test.md"]), "dir/test");
});

test("formatWikilink follows Obsidian-style basename-first behavior", () => {
	assert.strictEqual(formatWikilink("test.md", ["test.md", "other.md"]), "[[test]]");
	assert.strictEqual(formatWikilink("dir/test.md", ["dir/test.md", "other.md"]), "[[test]]");
	assert.strictEqual(formatWikilink("dir/test.md", ["test.md", "dir/test.md"]), "[[dir/test]]");
});

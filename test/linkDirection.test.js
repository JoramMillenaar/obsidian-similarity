const test = require("node:test");
const assert = require("node:assert");
const {linkDirection} = require("../dist/ui/linkDirection.js");

const LINKS = {
	"a.md": {"b.md": 1, "c.md": 2},
	"c.md": {"a.md": 1},
	"d.md": {"a.md": 1},
	"e.md": {"a.md": 0},
};

test("linkDirection reads both directions from resolved links", () => {
	assert.strictEqual(linkDirection(LINKS, "a.md", "b.md"), "outgoing");
	assert.strictEqual(linkDirection(LINKS, "a.md", "c.md"), "both");
	assert.strictEqual(linkDirection(LINKS, "a.md", "d.md"), "backlink");
	assert.strictEqual(linkDirection(LINKS, "a.md", "f.md"), "none");
});

test("linkDirection ignores zero counts and missing sources", () => {
	assert.strictEqual(linkDirection(LINKS, "a.md", "e.md"), "none");
	assert.strictEqual(linkDirection({}, "a.md", "b.md"), "none");
});

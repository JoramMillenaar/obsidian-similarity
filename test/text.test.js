const test = require("node:test");
const assert = require("node:assert");
const {hashText} = require("../dist/domain/text.js");

test("hashText returns stable hex digest", () => {
        const expected = "429b9d1e";
        assert.strictEqual(hashText("Sample text"), expected);
        assert.strictEqual(hashText("Sample text").length, 8);
});

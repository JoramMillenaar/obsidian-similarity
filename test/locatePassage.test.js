const test = require("node:test");
const assert = require("node:assert");

const {locatePassage} = require("../dist/core/text/locatePassage.js");

const located = (markdown, passage) => {
	const range = locatePassage(markdown, passage);
	return range && markdown.slice(range[0], range[1]);
};

test("a passage found verbatim is located exactly", () => {
	assert.strictEqual(located("Intro.\n\nThe cat sat on the mat. Then left.", "The cat sat on the mat."), "The cat sat on the mat.");
});

test("a passage is found through the markup its rendered text dropped", () => {
	const markdown = "# Notes\n\n- The **cat** sat on [[Mats/Red mat|the mat]], see [here](https://example.com/x).\n- Unrelated.";
	assert.strictEqual(
		located(markdown, "The cat sat on the mat, see here."),
		"The **cat** sat on [[Mats/Red mat|the mat]], see [here",
	);
});

test("a passage across lines is found as one range", () => {
	const markdown = "First line about\nsecond line continuing the thought.\n\nOther paragraph.";
	assert.strictEqual(located(markdown, "First line about second line continuing the thought."), "First line about\nsecond line continuing the thought");
});

test("the best match wins over an earlier partial one", () => {
	const markdown = "The cat ran. Later on: the cat sat on the red mat.";
	assert.strictEqual(located(markdown, "the cat sat on the red mat"), "the cat sat on the red mat");
});

test("a passage that isn't in the markdown is not located", () => {
	assert.strictEqual(locatePassage("Something else entirely.", "The cat sat on the mat."), null);
	assert.strictEqual(locatePassage("Anything", ""), null);
});

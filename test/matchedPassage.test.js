const test = require("node:test");
const assert = require("node:assert");

const {makeGetMatchedPassage} = require("../dist/search/getMatchedPassage.js");
const {hashText} = require("../dist/core/text/hash.js");

const span = (text, start, end) => ({start, end, hash: hashText(text.slice(start, end))});

test("a passage is read from its note, and dropped once the note changed", async () => {
	let noteText = "Title\nFirst sentence. Second sentence.";
	const getMatchedPassage = makeGetMatchedPassage({getNoteText: async () => ({text: noteText, truncated: false})});

	assert.strictEqual(await getMatchedPassage("a.md", span(noteText, 6, 21)), "First sentence.");

	const second = span(noteText, 22, 38);
	noteText = "Title\nThe note was edited since.";
	assert.strictEqual(await getMatchedPassage("a.md", second), null);
});

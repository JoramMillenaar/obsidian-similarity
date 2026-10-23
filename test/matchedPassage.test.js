const test = require("node:test");
const assert = require("node:assert");

const {makeGetMatchedPassage} = require("../dist/search/getMatchedPassage.js");
const {hashText} = require("../dist/core/text/hash.js");

const span = (text, start, end) => ({start, end, hash: hashText(text.slice(start, end))});

test("a passage is read from its note, or from the searched text, and dropped once it went stale", async () => {
	let noteText = "Title\nFirst sentence. Second sentence.";
	const getMatchedPassage = makeGetMatchedPassage({getNoteText: async () => ({text: noteText, truncated: false})});

	assert.strictEqual(await getMatchedPassage({noteId: "a.md"}, span(noteText, 6, 21)), "First sentence.");
	assert.strictEqual(await getMatchedPassage({text: "what I typed"}, span("what I typed", 7, 12)), "typed");

	const second = span(noteText, 22, 38);
	noteText = "Title\nThe note was edited since.";
	assert.strictEqual(await getMatchedPassage({noteId: "a.md"}, second), null);
});

const test = require("node:test");
const assert = require("node:assert");

const {makeGetNoteText} = require("../dist/app/getNoteText.js");

function makeDeps({markdown, title = "Note", maxRawMarkdownChars = 1000}) {
	return {
		vault: {
			getNote: async () => ({title, markdown}),
			extractText: async (boundedMarkdown) => boundedMarkdown,
		},
		settingsRepo: {get: () => ({maxRawMarkdownChars})},
	};
}

test("a note within the limit is not truncated", async () => {
	const getNoteText = makeGetNoteText(makeDeps({markdown: "short note"}));
	const result = await getNoteText("note.md");
	assert.strictEqual(result.truncated, false);
});

test("a note longer than maxRawMarkdownChars is reported as truncated", async () => {
	const getNoteText = makeGetNoteText(makeDeps({
		markdown: "x".repeat(50),
		maxRawMarkdownChars: 10,
	}));
	const result = await getNoteText("note.md");
	assert.strictEqual(result.truncated, true);
	assert.strictEqual(result.text.length <= 10 + "Note\n".length, true);
});

test("extracted text is not capped separately from the markdown", async () => {
	const getNoteText = makeGetNoteText(makeDeps({markdown: "x".repeat(50), maxRawMarkdownChars: 50}));
	const result = await getNoteText("note.md");
	assert.strictEqual(result.truncated, false);
	assert.strictEqual(result.text, `Note\n${"x".repeat(50)}`);
});

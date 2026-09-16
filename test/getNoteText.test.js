const test = require("node:test");
const assert = require("node:assert");

const {makeGetNoteText} = require("../dist/app/getNoteText.js");

function makeDeps({markdown, title = "Note", maxRawMarkdownChars = 1000, maxExtractedChars = 1000}) {
	return {
		vault: {
			getNote: async () => ({title, markdown}),
			extractText: async (boundedMarkdown) => boundedMarkdown,
		},
		settingsRepo: {get: () => ({maxRawMarkdownChars, maxExtractedChars})},
	};
}

test("a note within both limits is not truncated", async () => {
	const getNoteText = makeGetNoteText(makeDeps({markdown: "short note"}));
	const result = await getNoteText("note.md");
	assert.strictEqual(result.truncated, false);
});

test("a note longer than maxRawMarkdownChars is reported as truncated", async () => {
	const getNoteText = makeGetNoteText(makeDeps({
		markdown: "x".repeat(50),
		maxRawMarkdownChars: 10,
		maxExtractedChars: 1000,
	}));
	const result = await getNoteText("note.md");
	assert.strictEqual(result.truncated, true);
	assert.strictEqual(result.text.length <= 10 + "Note\n".length, true);
});

test("a note whose extracted text exceeds maxExtractedChars is reported as truncated", async () => {
	const getNoteText = makeGetNoteText(makeDeps({
		markdown: "x".repeat(50),
		maxRawMarkdownChars: 1000,
		maxExtractedChars: 10,
	}));
	const result = await getNoteText("note.md");
	assert.strictEqual(result.truncated, true);
	assert.strictEqual(result.text.length, 10);
});

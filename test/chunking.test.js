const test = require("node:test");
const assert = require("node:assert");

const {chunkText, countWords} = require("../dist/core/text/chunking.js");

function countTokens(text) {
	const trimmed = text.trim();
	return trimmed ? trimmed.split(/\s+/).length : 0;
}

const texts = (sentences) => sentences.map((sentence) => sentence.text);

test("countWords counts words in scripts written without spaces too", () => {
	assert.strictEqual(countWords("Four words, all here."), 4);
	assert.ok(countWords("我喜欢在阿姆斯特丹骑自行车。") > 1);
});

test("a chunk lists its sentences, with offsets back into the text", () => {
	const text = "  First one here.   Second one here. ";
	const [chunk] = chunkText(text, countTokens, 100);

	assert.deepStrictEqual(texts(chunk.sentences), ["First one here.", "Second one here."]);
	for (const sentence of chunk.sentences) {
		assert.strictEqual(text.slice(sentence.start, sentence.end), sentence.text);
	}
	assert.strictEqual(chunk.overlap, 0);
});

test("short sentences are only merged within a chunk's own sentences, never into its overlap", () => {
	// Budget 12 at 50%: 6 tokens of content per chunk, up to 6 tokens carried over.
	const text = "Alpha beta gamma delta. Hi. Epsilon zeta eta theta. Yo.";
	const chunks = chunkText(text, countTokens, 12, 50, 0, 3);

	assert.strictEqual(chunks.length, 2);
	assert.deepStrictEqual(texts(chunks[1].sentences), ["Alpha beta gamma delta.", "Hi.", "Epsilon zeta eta theta. Yo."]);
	assert.strictEqual(chunks[1].overlap, 2, "carried sentences are kept as they were, for context");
	for (const chunk of chunks) {
		const own = chunk.sentences.slice(chunk.overlap);
		assert.ok(own.length > 0, "every chunk has sentences of its own");
		assert.strictEqual(chunk.text, chunk.sentences.map((sentence) => sentence.text).join(" "),
			"the sentences are exactly what the chunk embeds");
	}
	const stored = chunks.flatMap((chunk) => texts(chunk.sentences.slice(chunk.overlap)));
	assert.strictEqual(stored.join(" "), text, "own sentences cover the text once, in order");
	assert.ok(stored.every((sentence) => countWords(sentence) >= 3), "no stored sentence is under the minimum");
});

test("sentences that are short even all together stay one", () => {
	const [chunk] = chunkText("Hi. Yo.", countTokens, 100, 0, 0, 5);
	assert.deepStrictEqual(texts(chunk.sentences), ["Hi. Yo."]);
});

test("a minimum of 0 keeps every sentence separate", () => {
	const [chunk] = chunkText("Hi. Yo.", countTokens, 100);
	assert.deepStrictEqual(texts(chunk.sentences), ["Hi.", "Yo."]);
});

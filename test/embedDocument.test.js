const test = require("node:test");
const assert = require("node:assert");

const {makeGenerateDocumentEmbeddings} = require("../dist/embedding/host/embedDocument.js");

// One "token" per whitespace-separated word, so chunk budgets are easy to reason about.
function countTokens(text) {
	const trimmed = text.trim();
	return trimmed ? trimmed.split(/\s+/).length : 0;
}

function makeModel(maxTokens, {minSentenceWords = 0, maxOverlapPercent = 0} = {}) {
	const calls = [];
	return {
		calls,
		ready: Promise.resolve(),
		config: {id: "model-a", maxTokens, maxOverlapPercent, minSentenceWords},
		countTokens,
		getQuant: () => ({vocab: "q4", ffn: "fp16"}),
		// One vector per sentence, distinct enough to tell them apart after normalizing.
		embedSentences: async (sentences) => {
			calls.push(sentences);
			return sentences.map((sentence) => new Float32Array([countTokens(sentence), 1]));
		},
	};
}

const SENTENCES = "One two three. Four five six. Seven eight nine. Ten eleven twelve.";

function spans(text, chunks) {
	return chunks.map((chunk) => text.slice(chunk.start, chunk.end));
}

test("the model's own token budget decides how the text is chunked", async () => {
	// maxTokens=100 (minus the 2-token special-token reserve) fits the whole text in one chunk.
	const roomy = makeModel(100);
	await makeGenerateDocumentEmbeddings(roomy)(SENTENCES);
	assert.strictEqual(roomy.calls.length, 1);

	// maxTokens=10 leaves a budget of 8, so the same text must be split.
	const tight = makeModel(10);
	await makeGenerateDocumentEmbeddings(tight)(SENTENCES);
	assert.ok(tight.calls.length > 1);
});

test("each sentence gets its own embedding, spanning exactly that sentence", async () => {
	const result = await makeGenerateDocumentEmbeddings(makeModel(100))(SENTENCES);

	assert.deepStrictEqual(spans(SENTENCES, result.chunks), [
		"One two three.",
		"Four five six.",
		"Seven eight nine.",
		"Ten eleven twelve.",
	]);
});

test("sentences shorter than the model's minimum are embedded together with the next", async () => {
	const text = "Heading. Two words. A sentence of plenty words here. Another sentence with enough words. Last one.";
	const result = await makeGenerateDocumentEmbeddings(makeModel(100, {minSentenceWords: 5}))(text);

	assert.deepStrictEqual(spans(text, result.chunks), [
		"Heading. Two words. A sentence of plenty words here.",
		// A short leftover at the end has nothing after it, so it joins the one before.
		"Another sentence with enough words. Last one.",
	]);
});

test("overlap sentences are context for the next chunk, not stored a second time", async () => {
	// Budget 8 at 50% overlap: 4 tokens of content per chunk, plus up to 4 carried over.
	const model = makeModel(10, {maxOverlapPercent: 50});
	const result = await makeGenerateDocumentEmbeddings(model)(SENTENCES);

	assert.ok(model.calls.length > 1, "the text is split");
	assert.ok(model.calls.slice(1).every((sentences) => sentences.length > 1), "later chunks carry earlier sentences");
	assert.deepStrictEqual(spans(SENTENCES, result.chunks), [
		"One two three.",
		"Four five six.",
		"Seven eight nine.",
		"Ten eleven twelve.",
	], "every sentence is stored exactly once, in order");
});

test("the model's vocab/FFN quantization is reported with every result", async () => {
	const generate = makeGenerateDocumentEmbeddings(makeModel(100));

	assert.deepStrictEqual((await generate(SENTENCES)).metadata.quant, {vocab: "q4", ffn: "fp16"});
	assert.deepStrictEqual((await generate("   ")).metadata.quant, {vocab: "q4", ffn: "fp16"});
});

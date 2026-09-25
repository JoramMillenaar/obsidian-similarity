const test = require("node:test");
const assert = require("node:assert");

const {makeGenerateDocumentEmbeddings} = require("../dist/embedding/host/embedDocument.js");

// One "token" per whitespace-separated word, so chunk budgets are easy to reason about.
function countTokens(text) {
	const trimmed = text.trim();
	return trimmed ? trimmed.split(/\s+/).length : 0;
}

function makeModel(maxTokens) {
	return {
		ready: Promise.resolve(),
		config: {id: "xenova-all-MiniLM-L6-v2", maxTokens},
		countTokens,
		getQuant: () => ({vocab: "q4", ffn: "fp16"}),
		embed: async (text) => new Float32Array([countTokens(text)]),
	};
}

const SENTENCES = "One two three. Four five six. Seven eight nine. Ten eleven twelve.";

test("maxChunkSize narrows the chunk budget below the model's own limit", async () => {
	// The model's own budget (maxTokens=100, minus the 2-token special-token reserve)
	// comfortably fits the whole text in a single chunk.
	const generate = makeGenerateDocumentEmbeddings(makeModel(100));

	const withoutLimit = await generate(SENTENCES);
	assert.strictEqual(withoutLimit.chunks.length, 1, "the full model budget fits everything in one chunk");

	const withLimit = await generate(SENTENCES, 0, 4);
	assert.ok(withLimit.chunks.length > 1, "a smaller maxChunkSize must actually split the text into more chunks");
	assert.strictEqual(withLimit.metadata.maxChunkSize, 4);
});

test("the model's vocab/FFN quantization is reported with every result", async () => {
	const generate = makeGenerateDocumentEmbeddings(makeModel(100));

	assert.deepStrictEqual((await generate(SENTENCES)).metadata.quant, {vocab: "q4", ffn: "fp16"});
	assert.deepStrictEqual((await generate("   ")).metadata.quant, {vocab: "q4", ffn: "fp16"});
});

test("maxChunkSize larger than the model's own budget still throws", async () => {
	const generate = makeGenerateDocumentEmbeddings(makeModel(10)); // budget = 10 - 2 = 8

	await assert.rejects(
		() => generate(SENTENCES, 0, 9),
		/maxChunkSize \(9\) exceeds the model's max chunk size \(8\)/,
	);
});

test("maxChunkSize equal to the model's own budget is accepted and used as-is", async () => {
	const generate = makeGenerateDocumentEmbeddings(makeModel(10)); // budget = 8

	const result = await generate(SENTENCES, 0, 8);
	assert.ok(result.chunks.length >= 1);
	assert.strictEqual(result.metadata.maxChunkSize, 8);
});

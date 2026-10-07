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

test("the model's own token budget decides how the text is chunked", async () => {
	// maxTokens=100 (minus the 2-token special-token reserve) fits the whole text in one chunk.
	const roomy = await makeGenerateDocumentEmbeddings(makeModel(100))(SENTENCES);
	assert.strictEqual(roomy.chunks.length, 1);

	// maxTokens=10 leaves a budget of 8, so the same text must be split.
	const tight = await makeGenerateDocumentEmbeddings(makeModel(10))(SENTENCES);
	assert.ok(tight.chunks.length > 1);
});

test("the model's vocab/FFN quantization is reported with every result", async () => {
	const generate = makeGenerateDocumentEmbeddings(makeModel(100));

	assert.deepStrictEqual((await generate(SENTENCES)).metadata.quant, {vocab: "q4", ffn: "fp16"});
	assert.deepStrictEqual((await generate("   ")).metadata.quant, {vocab: "q4", ffn: "fp16"});
});

const test = require("node:test");
const assert = require("node:assert");
const {similarityTier, scaleScore, SIMILARITY_TIER_LABELS} = require("../dist/core/vector/similarityTier.js");
const {EMBEDDING_MODELS} = require("../dist/constants.js");

const THRESHOLDS = [0.4, 0.6, 0.8];

test("similarityTier buckets by lower bounds, inclusive", () => {
	assert.strictEqual(similarityTier(0.25, THRESHOLDS), 0);
	assert.strictEqual(similarityTier(0.4, THRESHOLDS), 1);
	assert.strictEqual(similarityTier(0.79, THRESHOLDS), 2);
	assert.strictEqual(similarityTier(0.8, THRESHOLDS), 3);
	assert.strictEqual(similarityTier(1, THRESHOLDS), 3);
});

test("scaleScore gives each tier an equal quarter and is linear within it", () => {
	assert.strictEqual(scaleScore(0, THRESHOLDS), 0);
	assert.strictEqual(scaleScore(0.4, THRESHOLDS), 0.25);
	assert.strictEqual(scaleScore(0.5, THRESHOLDS), 0.375);
	assert.strictEqual(scaleScore(0.8, THRESHOLDS), 0.75);
	assert.strictEqual(scaleScore(1, THRESHOLDS), 1);
});

test("scaleScore is monotonic, so ranking by score and by scaled score agree", () => {
	let previous = -1;
	for (let score = 0; score <= 1; score += 0.01) {
		const scaled = scaleScore(score, THRESHOLDS);
		assert.ok(scaled >= previous, `scaleScore dropped at ${score}`);
		previous = scaled;
	}
});

test("every model has ascending thresholds strictly inside (0, 1)", () => {
	for (const model of Object.values(EMBEDDING_MODELS)) {
		const [a, b, c] = model.tierThresholds;
		assert.ok(0 < a && a < b && b < c && c < 1, `${model.id} thresholds must ascend within (0, 1)`);
	}
});

test("every tier has a label", () => {
	for (const tier of [0, 1, 2, 3]) assert.ok(SIMILARITY_TIER_LABELS[tier]);
});

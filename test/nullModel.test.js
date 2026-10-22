const test = require("node:test");
const assert = require("node:assert");
const {correctBest, correctMean} = require("../dist/core/vector/nullModel.js");
const {makeMatchScorer, makeNoteScorer} = require("../dist/core/vector/similarity.js");
const {EMBEDDING_MODEL} = require("../dist/constants.js");

const MODEL = EMBEDDING_MODEL.scoreNull;
const SCORES = [-0.5, -0.1, 0, 0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 0.95, 0.99];

test("the best match of a typical note pair keeps its raw score", () => {
	for (const s of SCORES) assert.ok(Math.abs(correctBest(MODEL, s, MODEL.refPairs) - s) < 1e-9, `best ${s}`);
});

test("one passage pair scores the same in both modes", () => {
	for (const s of SCORES) assert.ok(Math.abs(correctBest(MODEL, s, 1) - correctMean(MODEL, s, 1)) < 1e-5, `${s}`);
});

test("the best of more pairs is worth less, the mean of more pairs (above chance) more", () => {
	for (const s of [0.3, 0.5, 0.7]) {
		let best = correctBest(MODEL, s, 1);
		let mean = correctMean(MODEL, s, 1);
		for (const pairs of [4, 16, 64, 256, 1024, 4096]) {
			const nextBest = correctBest(MODEL, s, pairs);
			const nextMean = correctMean(MODEL, s, pairs);
			assert.ok(nextBest < best, `best ${s} over ${pairs} pairs`);
			assert.ok(nextMean > mean, `mean ${s} over ${pairs} pairs`);
			best = nextBest;
			mean = nextMean;
		}
	}
});

test("corrected scores stay within ±1 and keep their order wherever they could be shown", () => {
	for (const pairs of [1, 30, 1000, 10_000]) {
		for (const correct of [correctBest, correctMean]) {
			let previous = -Infinity;
			for (let s = -0.3; s < 0.995; s += 0.005) {
				const value = correct(MODEL, s, pairs);
				const label = `${correct.name}(${s.toFixed(3)}, ${pairs}) = ${value}`;
				assert.ok(value >= -1 && value <= 1, label);
				// Far below any shown score the lower tail may underflow to −1; above it, no ties.
				if (previous > EMBEDDING_MODEL.minScore) assert.ok(value > previous, label);
				else assert.ok(value >= previous, label);
				previous = value;
			}
		}
	}
});

function unit(seed, dim = 384) {
	let x = seed;
	const v = Array.from({length: dim}, () => ((x = (x * 16807) % 2147483647) / 2147483647) - 0.5);
	const norm = Math.hypot(...v);
	return Int8Array.from(v, (c) => Math.round((c / norm) * 127));
}

test("a note compared with itself scores (near) 1 in precise mode, regardless of length", () => {
	const short = [unit(1)];
	const long = [unit(2), unit(3), unit(4), unit(5)];
	assert.ok(makeMatchScorer("precise", short, MODEL)(short) > 0.999);
	assert.ok(makeMatchScorer("precise", long, MODEL)(long) > 0.99);
});

test("average mode scores the mean of all passage-pair similarities, without renormalizing", () => {
	const a = [unit(11), unit(12)];
	const b = [unit(13)];
	const cosine = (u, v) => u.reduce((sum, x, i) => sum + x * v[i], 0) / Math.hypot(...u) / Math.hypot(...v);
	const mean = (cosine(a[0], b[0]) + cosine(a[1], b[0])) / 2;
	assert.ok(Math.abs(makeMatchScorer("average", a, MODEL)(b) - correctMean(MODEL, mean, 2)) < 1e-6);
});

test("an empty note never ranks", () => {
	assert.strictEqual(makeMatchScorer("precise", [unit(1)], MODEL)([]), -Infinity);
	assert.strictEqual(makeMatchScorer("average", [], MODEL)([unit(1)]), -Infinity);
});

test("a note ranks by the better of its precise and average match, labelled with which one won", () => {
	const query = [unit(21), unit(22), unit(23)];
	for (const candidate of [[unit(21)], [unit(24), unit(25)], query, [unit(21), unit(22)]]) {
		const precise = makeMatchScorer("precise", query, MODEL)(candidate);
		const average = makeMatchScorer("average", query, MODEL)(candidate);
		const expected = average > precise ? {score: average, match: "average"} : {score: precise, match: "precise"};
		assert.deepStrictEqual(makeNoteScorer(query, MODEL)(candidate), expected);
	}
	// The same passage repeated: every pair agrees, which the mean rewards and the max penalizes.
	const repeated = [unit(31), unit(31)];
	const near = [unit(31).map((x, i) => (i % 7 === 0 ? -x : x)), unit(31).map((x, i) => (i % 7 === 0 ? -x : x))];
	assert.strictEqual(makeNoteScorer(repeated, MODEL)(near).match, "average");
});

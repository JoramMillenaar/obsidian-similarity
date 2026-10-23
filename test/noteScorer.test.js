const test = require("node:test");
const assert = require("node:assert");

const {bestPairCosine, makeMatchScorer} = require("../dist/core/vector/similarity.js");
const {correctBest} = require("../dist/core/vector/nullModel.js");
const {EMBEDDING_MODEL} = require("../dist/constants.js");

const MODEL = EMBEDDING_MODEL.scoreNull;
const DIM = 384;

function seeded(seed) {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
}

function randomVectors(random, count, dim = DIM) {
	return Array.from({length: count}, () => {
		const v = new Int8Array(dim);
		for (let i = 0; i < dim; i++) v[i] = Math.round(random() * 254) - 127;
		return v;
	});
}

function filled(value, dim = DIM) {
	return new Int8Array(dim).fill(value);
}

// A model with centering, so the packed path's shift and projection terms are exercised too.
function centeredModel(random) {
	const mean = Float32Array.from({length: DIM}, () => (random() - 0.5) * 0.03);
	const pc = Float32Array.from({length: DIM}, () => random() - 0.5);
	const norm = Math.hypot(...pc);
	return {...MODEL, mean, pc: pc.map((x) => x / norm)};
}

function reference(query, candidate, model = MODEL) {
	return correctBest(model, bestPairCosine(query, candidate, model), query.length * candidate.length);
}

test("precise scorer matches the pair-by-pair reference exactly for every query size", () => {
	const random = seeded(1);
	for (const model of [MODEL, centeredModel(random)]) {
		for (const queryCount of [1, 2, 3, 7, 8, 9, 16, 17, 33]) {
			const query = randomVectors(random, queryCount);
			const score = makeMatchScorer("precise", query, model);
			for (const candidateCount of [1, 2, 5]) {
				const candidate = randomVectors(random, candidateCount);
				assert.strictEqual(score(candidate), reference(query, candidate, model), `${queryCount}×${candidateCount}`);
			}
		}
	}
});

test("extreme components stay exact: the largest and most negative dots decode correctly", () => {
	const query = [filled(127), filled(-127), filled(127), filled(-127), filled(127)];
	for (const candidate of [[filled(127)], [filled(-127)]]) {
		assert.strictEqual(makeMatchScorer("precise", query, MODEL)(candidate), reference(query, candidate));
	}
	assert.strictEqual(makeMatchScorer("precise", [filled(-127)], MODEL)([filled(127)]), reference([filled(-127)], [filled(127)]));
});

test("the best pair is found whichever packed lane or remainder it lands in", () => {
	const random = seeded(3);
	for (let position = 0; position < 11; position++) {
		const query = randomVectors(random, 11).map((v) => v.map((x) => x >> 3));
		query[position] = filled(100);
		const candidate = [filled(100)];
		assert.strictEqual(makeMatchScorer("precise", query, MODEL)(candidate), reference(query, candidate), `best at ${position}`);
	}
});

test("dimensions beyond the packing bound fall back to the reference and stay exact", () => {
	const random = seeded(6);
	const query = randomVectors(random, 5, 1024);
	const candidate = randomVectors(random, 3, 1024);
	assert.strictEqual(makeMatchScorer("precise", query, MODEL)(candidate), reference(query, candidate));
});

test("bestPairIndices points at both passages of the best pair", () => {
	const {bestPairIndices} = require("../dist/core/vector/similarity.js");
	const random = seeded(7);
	for (const model of [MODEL, centeredModel(random)]) {
		const query = randomVectors(random, 4);
		const candidate = randomVectors(random, 6);
		// One passage copies a query passage, so the two make the best pair.
		candidate[3] = query[2].slice();
		assert.deepStrictEqual(bestPairIndices(query, candidate, model), {query: 2, candidate: 3});
	}
	assert.strictEqual(bestPairIndices([], [filled(1)], MODEL), null);
	assert.strictEqual(bestPairIndices([filled(1)], [], MODEL), null);
});

test("centroidChunkIndex picks the candidate passage nearest the query's centroid", () => {
	const {centroidChunkIndex} = require("../dist/core/vector/similarity.js");
	const random = seeded(8);
	for (const model of [MODEL, centeredModel(random)]) {
		const query = randomVectors(random, 4);
		const candidate = randomVectors(random, 6);
		const centroid = new Int8Array(DIM);
		for (let i = 0; i < DIM; i++) centroid[i] = Math.max(-127, Math.min(127, Math.round(query.reduce((sum, v) => sum + v[i], 0) / 2)));
		candidate[5] = centroid;
		assert.strictEqual(centroidChunkIndex(query, candidate, model), 5);
	}
	assert.strictEqual(centroidChunkIndex([], [filled(1)], MODEL), -1);
	assert.strictEqual(centroidChunkIndex([filled(1)], [], MODEL), -1);
});

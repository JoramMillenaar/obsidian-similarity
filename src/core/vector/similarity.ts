import { Embedding, IndexedNote, RelatedNote, SearchMode } from "../../types";
import { QUANT_SCALE } from "./codec";
import { correctBest, correctMean, ScoreNullModel } from "./nullModel";

export function normalizeEmbedding(embedding: Float32Array): Float32Array {
	const v = embedding;

	let sumSq = 0;
	for (let i = 0; i < v.length; i++) {
		const x = v[i];
		sumSq += x * x;
	}

	if (sumSq === 0) return v.slice();

	const invNorm = 1 / Math.sqrt(sumSq);
	const out = new Float32Array(v.length);
	for (let i = 0; i < v.length; i++) {
		out[i] = v[i] * invNorm;
	}
	return out;
}

export function quantizeEmbedding(v: Float32Array): Embedding {
	const out = new Int8Array(v.length);
	for (let i = 0; i < v.length; i++) {
		const q = Math.round(v[i] * QUANT_SCALE);
		// Manual clamp: Int8Array assignment wraps (128 -> -128) instead of saturating.
		out[i] = q > 127 ? 127 : q < -127 ? -127 : q;
	}
	return out;
}

function dotInt8(a: Int8Array, b: Int8Array): number {
	let sum = 0;
	for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
	return sum;
}

function dotFloat(a: Float32Array, b: ArrayLike<number>): number {
	let sum = 0;
	for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
	return sum;
}

/**
 * A passage as the null model compares it: centered (mean direction and top PC removed) and
 * normalized. Pair cosines come from the raw int8 dot plus these scalars, so stored vectors are
 * never rewritten: (a − μ − p_a·u)·(b − μ − p_b·u) = a·b − a·μ − b·μ + μ·μ − p_a·p_b.
 * All in int8 units (×127), like the stored vectors.
 */
type Passage = {
	model: ScoreNullModel;
	/** a·μ */
	shift: number;
	/** (a − μ)·u */
	proj: number;
	/** 1 / |a − μ − p_a·u| */
	invNorm: number;
};

// Stored vectors are immutable, so a passage's scalars are computed once, not on every query.
const passageCache = new WeakMap<Embedding, Passage>();

function passageOf(v: Embedding, model: ScoreNullModel): Passage {
	const cached = passageCache.get(v);
	if (cached?.model === model) return cached;

	const {mean, pc} = model;
	const shift = mean ? dotFloat(mean, v) * QUANT_SCALE : 0;
	const proj = pc ? dotFloat(pc, v) - (mean ? dotFloat(mean, pc) : 0) * QUANT_SCALE : 0;
	const normSq = dotInt8(v, v) - 2 * shift + meanSquare(model) - proj * proj;
	const passage = {model, shift, proj, invNorm: normSq > 0 ? QUANT_SCALE / Math.sqrt(normSq) : 0};
	passageCache.set(v, passage);
	return passage;
}

const meanSquare = (model: ScoreNullModel) => (model.mean ? dotFloat(model.mean, model.mean) * QUANT_SCALE * QUANT_SCALE : 0);

function centeredBest(a: Embedding[], b: Embedding[], model: ScoreNullModel): number {
	const meanSq = meanSquare(model);
	const right = b.map((v) => passageOf(v, model));
	let best = -Infinity;
	for (const left of a) {
		const p = passageOf(left, model);
		for (let j = 0; j < b.length; j++) {
			const q = right[j];
			const cos = (dotInt8(left, b[j]) - p.shift - q.shift + meanSq - p.proj * q.proj) * p.invNorm * q.invNorm;
			if (cos > best) best = cos;
		}
	}
	return best / (QUANT_SCALE * QUANT_SCALE);
}

/**
 * The mean of a note's centered unit passages. Not renormalized: the dot of two such means is
 * exactly the mean of all n·m passage-pair cosines, whose expectation doesn't depend on note length
 * (renormalizing divides by norms that shrink as long notes average out, inflating their scores).
 */
function centeredMean(vectors: Embedding[], model: ScoreNullModel): Float32Array {
	const {mean, pc} = model;
	const dim = vectors[0].length;
	const out = new Float32Array(dim);
	let offset = 0;
	for (const v of vectors) {
		const {proj, invNorm} = passageOf(v, model);
		const scale = invNorm / (QUANT_SCALE * vectors.length);
		for (let k = 0; k < dim; k++) out[k] += v[k] * scale;
		offset += scale;
		if (pc) {
			const shift = proj * scale;
			for (let k = 0; k < dim; k++) out[k] -= pc[k] * shift;
		}
	}
	if (mean) for (let k = 0; k < dim; k++) out[k] -= mean[k] * offset * QUANT_SCALE;
	return out;
}

export function makeNoteScorer(
	mode: SearchMode,
	queryChunks: Embedding[],
	model: ScoreNullModel,
): (candidateChunks: Embedding[]) => number {
	const queryMean = mode === "average" && queryChunks.length ? centeredMean(queryChunks, model) : null;

	return (candidateChunks) => {
		if (!queryChunks.length || !candidateChunks.length) return -Infinity;
		const pairs = queryChunks.length * candidateChunks.length;
		if (queryMean) {
			return correctMean(model, dotFloat(queryMean, centeredMean(candidateChunks, model)), pairs);
		}
		return correctBest(model, centeredBest(queryChunks, candidateChunks, model), pairs);
	};
}

export type ScoredNote = Pick<RelatedNote, "id" | "score">;

export function selectTopScores(
	scores: Iterable<ScoredNote>,
	options: {limit?: number; minScore?: number} = {},
): ScoredNote[] {
	const {limit = 10, minScore = 0} = options;
	const kept: ScoredNote[] = [];
	for (const r of scores) {
		if (Number.isFinite(r.score) && r.score >= minScore) kept.push(r);
	}
	return kept.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function rankSimilarNotes(
	queryChunks: Embedding[],
	notes: IndexedNote[],
	model: ScoreNullModel,
	options: {excludeId?: string; limit?: number; minScore?: number; mode?: SearchMode} = {},
): ScoredNote[] {
	const {excludeId, mode = "granular"} = options;
	const score = makeNoteScorer(mode, queryChunks, model);

	return selectTopScores(
		notes
			.filter((n) => (excludeId ? n.id !== excludeId : true))
			.map((n) => ({id: n.id, score: score(n.chunks.map((chunk) => chunk.embedding))})),
		options,
	);
}

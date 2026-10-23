import { Embedding, IndexedNote, MatchKind, RelatedNote } from "../../types";
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

/** The best centered passage-pair cosine, one pair at a time. The reference for {@link makeBestScorer}. */
export function bestPairCosine(a: Embedding[], b: Embedding[], model: ScoreNullModel): number {
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
 * Two int8 query vectors share one float64 lane: `lo + hi * 2^26`. Multiplying that by a
 * candidate component computes both products at once, and as long as every dot product stays
 * below 2^23 in magnitude the packed sum is an exact integer under 2^53 that splits back into
 * both dots. That bound holds up to MAX_PACKED_DIM (127 * 127 * dim < 2^23).
 */
const PACK_SHIFT = 2 ** 26;
const MAX_PACKED_DIM = Math.floor((2 ** 23 - 1) / (QUANT_SCALE * QUANT_SCALE));

function packQueryPairs(query: Embedding[], dim: number): Float64Array {
	const pairs = Math.ceil(query.length / 2);
	const packed = new Float64Array(pairs * dim);
	for (let p = 0; p < pairs; p++) {
		const lo = query[2 * p];
		// An odd last vector is paired with itself: a duplicate can't change the maximum.
		const hi = query[2 * p + 1] ?? lo;
		const base = p * dim;
		for (let i = 0; i < dim; i++) packed[base + i] = lo[i] + hi[i] * PACK_SHIFT;
	}
	return packed;
}

/**
 * Same result as {@link bestPairCosine}, bit for bit, but about twice as fast: each pass over a
 * candidate vector computes the exact integer dots of eight query vectors at once, which are then
 * unpacked and centered and normalized per pair exactly as the reference does.
 */
function makeBestScorer(query: Embedding[], model: ScoreNullModel): (candidates: Embedding[]) => number {
	const dim = query[0].length;
	if (dim > MAX_PACKED_DIM) return (candidates) => bestPairCosine(query, candidates, model);

	const meanSq = meanSquare(model);
	const packed = packQueryPairs(query, dim);
	const pairs = Math.ceil(query.length / 2);
	// Per query vector (the odd last one doubled, like its packed lane): shift, proj and invNorm.
	const passages = Array.from({length: 2 * pairs}, (_, k) => passageOf(query[Math.min(k, query.length - 1)], model));
	const shift = Float64Array.from(passages, (p) => p.shift);
	const proj = Float64Array.from(passages, (p) => p.proj);
	const invNorm = Float64Array.from(passages, (p) => p.invNorm);

	return (candidates) => {
		let best = -Infinity;
		const consider = (sum: number, p: number, qShift: number, qProj: number, qInvNorm: number) => {
			const hiDot = Math.round(sum / PACK_SHIFT);
			const loDot = sum - hiDot * PACK_SHIFT;
			const lo = 2 * p;
			const hi = lo + 1;
			const loCos = (loDot - shift[lo] - qShift + meanSq - proj[lo] * qProj) * invNorm[lo] * qInvNorm;
			const hiCos = (hiDot - shift[hi] - qShift + meanSq - proj[hi] * qProj) * invNorm[hi] * qInvNorm;
			if (loCos > best) best = loCos;
			if (hiCos > best) best = hiCos;
		};

		for (const c of candidates) {
			const q = passageOf(c, model);
			let p = 0;
			for (; p + 4 <= pairs; p += 4) {
				const b0 = p * dim, b1 = b0 + dim, b2 = b1 + dim, b3 = b2 + dim;
				let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
				for (let i = 0; i < dim; i++) {
					const x = c[i];
					s0 += packed[b0 + i] * x;
					s1 += packed[b1 + i] * x;
					s2 += packed[b2 + i] * x;
					s3 += packed[b3 + i] * x;
				}
				consider(s0, p, q.shift, q.proj, q.invNorm);
				consider(s1, p + 1, q.shift, q.proj, q.invNorm);
				consider(s2, p + 2, q.shift, q.proj, q.invNorm);
				consider(s3, p + 3, q.shift, q.proj, q.invNorm);
			}
			for (; p < pairs; p++) {
				const base = p * dim;
				let s = 0;
				for (let i = 0; i < dim; i++) s += packed[base + i] * c[i];
				consider(s, p, q.shift, q.proj, q.invNorm);
			}
		}
		return best / (QUANT_SCALE * QUANT_SCALE);
	};
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

export function makeMatchScorer(
	kind: MatchKind,
	queryChunks: Embedding[],
	model: ScoreNullModel,
): (candidateChunks: Embedding[]) => number {
	if (!queryChunks.length) return () => -Infinity;

	if (kind === "average") {
		const queryMean = centeredMean(queryChunks, model);
		return (candidateChunks) => candidateChunks.length
			? correctMean(model, dotFloat(queryMean, centeredMean(candidateChunks, model)), queryChunks.length * candidateChunks.length)
			: -Infinity;
	}

	const best = makeBestScorer(queryChunks, model);
	return (candidateChunks) => candidateChunks.length
		? correctBest(model, best(candidateChunks), queryChunks.length * candidateChunks.length)
		: -Infinity;
}

/** The passage pair a precise match rests on, as indices into each side; null without chunks on either side. */
export function bestPairIndices(
	queryChunks: Embedding[],
	candidateChunks: Embedding[],
	model: ScoreNullModel,
): {query: number; candidate: number} | null {
	if (!queryChunks.length || !candidateChunks.length) return null;

	const meanSq = meanSquare(model);
	const right = candidateChunks.map((v) => passageOf(v, model));
	let best = -Infinity;
	let pair = {query: 0, candidate: 0};
	for (let i = 0; i < queryChunks.length; i++) {
		const left = queryChunks[i];
		const p = passageOf(left, model);
		for (let j = 0; j < candidateChunks.length; j++) {
			const q = right[j];
			const cos = (dotInt8(left, candidateChunks[j]) - p.shift - q.shift + meanSq - p.proj * q.proj) * p.invNorm * q.invNorm;
			if (cos > best) [best, pair] = [cos, {query: i, candidate: j}];
		}
	}
	return pair;
}

/**
 * The candidate passage closest to the query's centroid: the largest term of an average match,
 * whose score is the mean over candidate passages of queryMean · passage. -1 without chunks on either side.
 */
export function centroidChunkIndex(queryChunks: Embedding[], candidateChunks: Embedding[], model: ScoreNullModel): number {
	if (!queryChunks.length || !candidateChunks.length) return -1;

	const {mean, pc} = model;
	const queryMean = centeredMean(queryChunks, model);
	const offset = mean ? dotFloat(queryMean, mean) * QUANT_SCALE : 0;
	const pcDot = pc ? dotFloat(queryMean, pc) : 0;
	let best = -Infinity;
	let bestIndex = 0;
	for (let j = 0; j < candidateChunks.length; j++) {
		const q = passageOf(candidateChunks[j], model);
		const cos = (dotFloat(queryMean, candidateChunks[j]) - offset - q.proj * pcDot) * q.invNorm;
		if (cos > best) [best, bestIndex] = [cos, j];
	}
	return bestIndex;
}

export type NoteMatch = Pick<RelatedNote, "score" | "match">;

/** Scores a candidate both ways and keeps the better; they share one scale, so either can win (precise on a tie). */
export function makeNoteScorer(queryChunks: Embedding[], model: ScoreNullModel): (candidateChunks: Embedding[]) => NoteMatch {
	const precise = makeMatchScorer("precise", queryChunks, model);
	const average = makeMatchScorer("average", queryChunks, model);
	return (candidateChunks) => {
		const best = precise(candidateChunks);
		const mean = average(candidateChunks);
		return mean > best ? {score: mean, match: "average"} : {score: best, match: "precise"};
	};
}

export type ScoredNote = Pick<RelatedNote, "id" | "score" | "match">;

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
	options: {excludeId?: string; limit?: number; minScore?: number} = {},
): ScoredNote[] {
	const {excludeId} = options;
	const score = makeNoteScorer(queryChunks, model);

	return selectTopScores(
		notes
			.filter((n) => (excludeId ? n.id !== excludeId : true))
			.map((n) => ({id: n.id, ...score(n.chunks.map((chunk) => chunk.embedding))})),
		options,
	);
}

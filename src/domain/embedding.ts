import { Embedding } from "../types";
import { QUANT_SCALE } from "./embeddingCodec";

/** Scales a raw model-output vector to unit length. Needs float precision, so it runs before quantization, not on the stored Embedding. */
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

/** Packs a unit-normalized float vector into the int8 Embedding representation stored/compared everywhere downstream. */
export function quantizeEmbedding(v: Float32Array): Embedding {
	const out = new Int8Array(v.length);
	for (let i = 0; i < v.length; i++) {
		const q = Math.round(v[i] * QUANT_SCALE);
		// Manual clamp: Int8Array assignment wraps (128 -> -128) instead of saturating.
		out[i] = q > 127 ? 127 : q < -127 ? -127 : q;
	}
	return out;
}

/**
 * Similarity between two chunked documents: the best score over every pair of
 * chunks. Two notes are related if ANY passage of one matches any passage of
 * the other — averaging the chunks instead would dilute a strong local match
 * into the noise of the whole note.
 */
export function maxPairwiseSimilarity(a: Embedding[], b: Embedding[]): number {
	let best = -Infinity;

	for (const left of a) {
		for (const right of b) {
			const score = dotProductSimilarity(left, right);
			if (score > best) best = score;
		}
	}

	return Number.isFinite(best) ? best : 0;
}

export function dotProductSimilarity(a: Embedding, b: Embedding): number {
	if (a.length !== b.length) {
		throw new Error(`dotProductSimilarity: length mismatch (${a.length} vs ${b.length})`);
	}

	let dot = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
	}

	const raw = dot / (QUANT_SCALE * QUANT_SCALE);
	// Int8 quantization rounding can push near-duplicate vectors slightly past 1 (e.g. 1.01); clamp back to the valid similarity domain.
	return raw > 1 ? 1 : raw < 0 ? 0 : raw;
}

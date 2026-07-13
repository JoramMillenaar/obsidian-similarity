import { Embedding } from "../types";

export function normalizeEmbedding(embedding: Embedding): Embedding {
	const v = embedding;

	let sumSq = 0;
	for (let i = 0; i < v.length; i++) {
		const x = v[i];
		sumSq += x * x;
	}

	if (sumSq === 0) return v.slice();

	const invNorm = 1 / Math.sqrt(sumSq);
	const out = new Array<number>(v.length);
	for (let i = 0; i < v.length; i++) {
		out[i] = v[i] * invNorm;
	}
	return out;
}

export function averageEmbeddings(embeddings: Embedding[]): Embedding | null {
	if (embeddings.length === 0) return null;

	const embeddingSize = embeddings[0].length;
	const meanEmbedding = new Array<number>(embeddingSize).fill(0);

	for (const embedding of embeddings) {
		if (embedding.length !== embeddingSize) {
			throw new Error(`averageEmbeddings: length mismatch (${embedding.length} vs ${embeddingSize})`);
		}

		for (let i = 0; i < embeddingSize; i++) {
			meanEmbedding[i] += embedding[i];
		}
	}

	for (let i = 0; i < embeddingSize; i++) {
		meanEmbedding[i] /= embeddings.length;
	}

	return meanEmbedding;
}

/**
 * Best (highest) cosine similarity between a query vector and any of a note's
 * chunk vectors. This is how a multi-chunk note is scored: its most similar
 * passage wins, which keeps search to one result per note.
 */
export function maxCosineSimilarity(query: number[], vectors: number[][]): number {
	let best = -Infinity;
	for (const vector of vectors) {
		const score = cosineSimilarity(query, vector);
		if (score > best) best = score;
	}
	return best;
}

export function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length) {
		throw new Error(`cosineSimilarity: length mismatch (${a.length} vs ${b.length})`);
	}

	let dot = 0;
	let aSq = 0;
	let bSq = 0;

	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		const y = b[i];
		dot += x * y;
		aSq += x * x;
		bSq += y * y;
	}

	const denom = Math.sqrt(aSq) * Math.sqrt(bSq);
	if (denom === 0) return 0;

	return dot / denom;
}

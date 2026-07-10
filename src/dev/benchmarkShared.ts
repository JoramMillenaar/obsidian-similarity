/**
 * DEV-ONLY benchmark primitives shared across the indexing and storage
 * benchmarks: a monotonic clock, summary stats, a deterministic PRNG, synthetic
 * index generation, a best-effort heap probe, and small formatters.
 *
 * Only ever reached behind an `if (__DEV__)` guard, so it is tree-shaken out of
 * production builds along with its importers.
 */
import { IndexedNote } from "../types";

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

export const now: () => number =
	typeof performance !== "undefined" && typeof performance.now === "function"
		? () => performance.now()
		: () => Date.now();

export interface Stats {
	mean: number;
	median: number;
	p95: number;
	min: number;
	max: number;
}

export function summarize(values: number[]): Stats {
	if (values.length === 0) {
		return {mean: 0, median: 0, p95: 0, min: 0, max: 0};
	}
	const sorted = [...values].sort((a, b) => a - b);
	const sum = sorted.reduce((acc, v) => acc + v, 0);
	const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
	return {
		mean: sum / sorted.length,
		median: at(0.5),
		p95: at(0.95),
		min: sorted[0],
		max: sorted[sorted.length - 1],
	};
}

/** Median wall-clock ms of `fn` over `iterations` runs, after `warmup` untimed runs. */
export async function measure(
	fn: () => void | Promise<void>,
	iterations: number,
	warmup: number,
): Promise<Stats> {
	for (let i = 0; i < warmup; i++) await fn();
	const samples: number[] = [];
	for (let i = 0; i < iterations; i++) {
		const s = now();
		await fn();
		samples.push(now() - s);
	}
	return summarize(samples);
}

// ---------------------------------------------------------------------------
// Deterministic synthetic index data
// ---------------------------------------------------------------------------

/** Deterministic PRNG so runs are reproducible across before/after comparisons. */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function randomUnitEmbedding(dim: number, rng: () => number): number[] {
	const v = new Array<number>(dim);
	let sumSq = 0;
	for (let i = 0; i < dim; i++) {
		const x = rng() * 2 - 1;
		v[i] = x;
		sumSq += x * x;
	}
	const inv = sumSq > 0 ? 1 / Math.sqrt(sumSq) : 0;
	for (let i = 0; i < dim; i++) v[i] *= inv;
	return v;
}

export function makeSeedIndex(count: number, dim: number, rng: () => number): IndexedNote[] {
	const notes: IndexedNote[] = [];
	for (let i = 0; i < count; i++) {
		notes.push({
			id: `seed-${i}.md`,
			embedding: randomUnitEmbedding(dim, rng),
			contentHash: Math.floor(rng() * 0xffffffff).toString(16).padStart(8, "0"),
			updatedAt: new Date(0).toISOString(),
		});
	}
	return notes;
}

// ---------------------------------------------------------------------------
// Memory & formatting
// ---------------------------------------------------------------------------

/**
 * Best-effort resident JS heap in MB.
 *
 * Prefers Node/Electron's `process.memoryUsage().heapUsed`; falls back to the
 * Chrome-only `performance.memory.usedJSHeapSize` when running in a plain
 * browser. Returns null when neither is exposed. Readings are noisy without a
 * forced GC — read trends, not absolutes.
 */
export function heapUsedMB(): number | null {
	if (typeof process !== "undefined" && typeof process.memoryUsage === "function") {
		return process.memoryUsage().heapUsed / 1024 / 1024;
	}
	const mem = (globalThis as { performance?: { memory?: { usedJSHeapSize: number } } }).performance?.memory;
	if (mem && typeof mem.usedJSHeapSize === "number") {
		return mem.usedJSHeapSize / 1024 / 1024;
	}
	return null;
}

export function ms(n: number): string {
	return `${n.toFixed(2)}ms`;
}

export function kb(bytes: number): string {
	return `${(bytes / 1024).toFixed(1)}KB`;
}

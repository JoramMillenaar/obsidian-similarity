/**
 * DEV-ONLY index-storage backend comparison.
 *
 * Answers the single question "how do the JSON and binary `IndexStorage`
 * backends perform differently?" without the noise of the full indexing
 * pipeline. Everything above `IndexStorage` (the repo, embed, prepare) is
 * identical for both backends, so this benchmark exercises the storage layer
 * *directly* on a synthetic index of N notes.
 *
 * It reports two things side by side:
 *   1. Codec CPU + serialized size (in-memory, no disk) — JSON.stringify/parse
 *      vs encodeIndex/decodeIndex, plus the persisted payload size and the
 *      parsed-index heap footprint.
 *   2. Real disk round-trip — the actual `rewrite`/`getAll` latency through the
 *      vault {@link DataAdapter}, i.e. the disk cost the in-memory numbers omit.
 *
 * Both backends run against *throwaway scratch files* (`index.bench.bin` /
 * `index.bench.json`) that are deleted afterwards, so the live index in
 * `data.json` / `index.bin` is never touched.
 *
 * Only ever reached behind an `if (__DEV__)` guard, so it is tree-shaken out of
 * production builds.
 */
import { DataAdapter, normalizePath } from "obsidian";
import { IndexedNote } from "../types";
import { IndexStorage } from "../ports";
import { BinaryVaultIndexStorage } from "../infra/index/binaryVaultIndexStorage";
import { decodeIndex, encodeIndex } from "../infra/index/binaryIndexCodec";
import {
	heapUsedMB,
	kb,
	makeSeedIndex,
	measure,
	ms,
	mulberry32,
} from "./benchmarkShared";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface StorageBenchmarkOptions {
	/** Vault data adapter used to read/write the scratch files. */
	adapter: DataAdapter;
	/** Directory the throwaway scratch index files are written into (e.g. the plugin dir). */
	scratchDir: string;
	/** Where to print human-readable progress/results. Defaults to console.log. */
	log?: (message: string) => void;
	/** Measured iterations per scenario (after warmup). Default 5. */
	iterations?: number;
	/** Warmup iterations (not measured). Default 1. */
	warmup?: number;
	/** Vault sizes N swept to expose scaling. */
	sweepSizes?: number[];
	/** Embedding dimensionality of the synthetic notes. Default 384 (the model's). */
	dim?: number;
}

const DEFAULT_SWEEP_SIZES = [100, 500, 1000, 2000, 5000];
const DEFAULT_DIM = 384;

// ---------------------------------------------------------------------------
// Scratch JSON storage (faithful to ObsidianPluginDataIndexStorage, minus the
// shared data.json — writes to its own throwaway file via the same adapter).
// ---------------------------------------------------------------------------

/**
 * The live JSON backend persists the index inside the plugin's `data.json`
 * through `saveData` — which is itself `adapter.write(dataPath, JSON.stringify)`.
 * This mirrors that exactly (whole-index `JSON.stringify` / `JSON.parse` through
 * the vault adapter) but points at a scratch file so the real `data.json` is
 * never mutated. The index is nested under an `index` key, as it is in the real
 * plugin data; the sibling keys (settings, flags) are negligible and omitted.
 */
class ScratchJsonIndexStorage implements IndexStorage {
	constructor(
		private readonly adapter: DataAdapter,
		private readonly filePath: string,
	) {
	}

	async getAll(): Promise<IndexedNote[]> {
		if (!(await this.adapter.exists(this.filePath))) return [];
		const raw = await this.adapter.read(this.filePath);
		return (JSON.parse(raw) as { index: IndexedNote[] }).index;
	}

	async rewrite(index: IndexedNote[]): Promise<void> {
		await this.adapter.write(this.filePath, JSON.stringify({ index }));
	}

	async isEmpty(): Promise<boolean> {
		return (await this.getAll()).length === 0;
	}
}

// ---------------------------------------------------------------------------
// Per-backend codec (in-memory serialize/deserialize, no disk)
// ---------------------------------------------------------------------------

interface Codec {
	name: string;
	/** Serialize the whole index to its persisted form (string or buffer). */
	serialize(index: IndexedNote[]): unknown;
	/** Parse a serialized blob back into an index. */
	deserialize(blob: unknown): IndexedNote[];
	/** Byte size of a serialized blob. */
	byteLength(blob: unknown): number;
}

const jsonCodec: Codec = {
	name: "json",
	serialize: (index) => JSON.stringify({ index }),
	deserialize: (blob) => (JSON.parse(blob as string) as { index: IndexedNote[] }).index,
	byteLength: (blob) => new TextEncoder().encode(blob as string).length,
};

const binaryCodec: Codec = {
	name: "binary",
	serialize: (index) => encodeIndex(index),
	deserialize: (blob) => decodeIndex(blob as ArrayBuffer),
	byteLength: (blob) => (blob as ArrayBuffer).byteLength,
};

// ---------------------------------------------------------------------------
// Reporting helpers
// ---------------------------------------------------------------------------

function row(cells: [string, number][]): string {
	return "  " + cells.map(([text, width]) => text.padStart(width)).join("");
}

// Prevents the JS engine from optimizing away the decode whose heap we measure.
let heapSink = 0;

async function fileSize(adapter: DataAdapter, path: string): Promise<number> {
	const stat = await adapter.stat(path);
	return stat?.size ?? 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runStorageBenchmark(opts: StorageBenchmarkOptions): Promise<void> {
	const log = opts.log ?? ((m: string) => console.log(m));
	const iterations = opts.iterations ?? 5;
	const warmup = opts.warmup ?? 1;
	const sweepSizes = opts.sweepSizes ?? DEFAULT_SWEEP_SIZES;
	const dim = opts.dim ?? DEFAULT_DIM;

	const binPath = normalizePath(`${opts.scratchDir}/index.bench.bin`);
	const jsonPath = normalizePath(`${opts.scratchDir}/index.bench.json`);

	log("════════════════════════════════════════════════════════════════");
	log("  Index storage comparison — JSON vs Binary");
	log(`  iterations=${iterations} warmup=${warmup} dim=${dim}`);
	log("════════════════════════════════════════════════════════════════");

	const codecs = [jsonCodec, binaryCodec];

	try {
		// --- Section 1: codec CPU + serialized size (in-memory) ------------
		log("");
		log("▸ Codec CPU + serialized size (in-memory, no disk)");
		log(
			row([
				["N", 8],
				["backend", 10],
				["serialize", 12],
				["deserialize", 13],
				["bytes", 12],
				["heapΔ", 10],
			]),
		);

		for (const n of sweepSizes) {
			const seed = makeSeedIndex(n, dim, mulberry32(0x5100 + n));
			for (const codec of codecs) {
				const blob = codec.serialize(seed);
				const bytes = codec.byteLength(blob);

				const serializeMs = await measure(() => void codec.serialize(seed), iterations, warmup);
				const deserializeMs = await measure(() => void codec.deserialize(blob), iterations, warmup);

				const heapBefore = heapUsedMB();
				const decoded = codec.deserialize(blob);
				const heapAfter = heapUsedMB();
				heapSink += decoded.length; // keep `decoded` live across the measurement
				const heapDelta = heapBefore === null || heapAfter === null ? null : heapAfter - heapBefore;

				log(
					row([
						[codec === codecs[0] ? String(n) : "", 8],
						[codec.name, 10],
						[ms(serializeMs.median), 12],
						[ms(deserializeMs.median), 13],
						[kb(bytes), 12],
						[heapDelta === null ? "n/a" : `${heapDelta.toFixed(2)}MB`, 10],
					]),
				);
			}
		}

		// --- Section 2: real disk round-trip (scratch files) --------------
		log("");
		log("▸ Real disk round-trip (scratch files via vault adapter)");
		log(
			row([
				["N", 8],
				["backend", 10],
				["rewrite", 12],
				["getAll", 12],
				["diskBytes", 13],
			]),
		);

		const backends: { name: string; storage: IndexStorage; path: string }[] = [
			{ name: "json", storage: new ScratchJsonIndexStorage(opts.adapter, jsonPath), path: jsonPath },
			{ name: "binary", storage: new BinaryVaultIndexStorage(opts.adapter, binPath), path: binPath },
		];

		for (const n of sweepSizes) {
			const seed = makeSeedIndex(n, dim, mulberry32(0x5200 + n));
			for (let i = 0; i < backends.length; i++) {
				const { name, storage, path } = backends[i];
				const writeMs = await measure(() => storage.rewrite(seed), iterations, warmup);
				const readMs = await measure(async () => void (await storage.getAll()), iterations, warmup);
				const diskBytes = await fileSize(opts.adapter, path);

				log(
					row([
						[i === 0 ? String(n) : "", 8],
						[name, 10],
						[ms(writeMs.median), 12],
						[ms(readMs.median), 12],
						[kb(diskBytes), 13],
					]),
				);
			}
		}

		log("");
		log("  Notes:");
		log("   • serialize = JSON.stringify vs encodeIndex; deserialize = JSON.parse vs decodeIndex.");
		log("   • bytes/diskBytes = persisted payload (binary packs float32; JSON writes float64 text).");
		log("   • heapΔ ≈ parsed IndexedNote[] footprint. decodeIndex returns number[] (float64), so the");
		log("     binary index is ~the same size in memory as JSON's — the win is disk/serialized size.");
		log("   • disk write latency ≈ rewrite − serialize; disk read latency ≈ getAll − deserialize.");
		log("   • heap deltas are best-effort (no forced GC unless --expose-gc); read the trend.");
		log(`   • scratch files: ${jsonPath}, ${binPath} (removed on completion).`);
	} finally {
		// Never leave scratch files behind, even if a measurement throws.
		for (const path of [binPath, jsonPath]) {
			try {
				if (await opts.adapter.exists(path)) await opts.adapter.remove(path);
			} catch (error) {
				log(`  (warning) failed to remove scratch file ${path}: ${String(error)}`);
			}
		}
	}

	log("");
	log(`✓ Storage benchmark complete. (heapSink=${heapSink})`);
}

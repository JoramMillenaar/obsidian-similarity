/**
 * DEV-ONLY comparison of the two index-storage shapes: the pre-migration
 * legacy JSON (embeddings inline as float64 JSON arrays) vs the current
 * binary-sidecar backend ({@link ObsidianPluginDataIndexStorage}).
 *
 * Everything above the storage boundary (repo, embed, prepare) is identical
 * across both, so this benchmark exercises storage *directly* on a synthetic
 * index of N notes, reusing the real domain codec
 * ({@link encodeEmbeddings}/{@link decodeEmbeddings}) and migration transform
 * ({@link packIndexedNotesToV2}/{@link unpackV2ToIndexedNotes}) so the numbers
 * reflect the actual production code path, not a re-implementation of it.
 *
 * It reports two things side by side:
 *   1. Codec CPU + serialized size (in-memory, no disk) — JSON.stringify/parse
 *      of the whole legacy index vs the binary encode/decode + slim-JSON
 *      stringify/parse, plus the persisted payload size.
 *   2. Real disk round-trip — the actual read/write latency through the vault
 *      {@link DataAdapter}, i.e. the disk cost the in-memory numbers omit.
 *
 * Both backends write to *throwaway scratch files* (`index.bench.json` /
 * `index.bench.json` + `index.bench.bin`) under the plugin directory, deleted
 * afterwards — the live `data.json` / `embeddings.bin` are never touched.
 *
 * Only ever reached behind an `if (__DEV__)` guard, so it is tree-shaken out of
 * production builds.
 */
import { DataAdapter, normalizePath } from "obsidian";
import { IndexedNote } from "../types";
import { decodeEmbeddings, encodeEmbeddings } from "../domain/embeddingCodec";
import { packIndexedNotesToV2, unpackV2ToIndexedNotes } from "../domain/migrateEmbeddingStore";
import { heapUsedMB, kb, makeSeedIndex, measure, ms, mulberry32 } from "./benchmarkShared";

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
// Scratch backends — same on-disk shape as the two real implementations, but
// pointed at throwaway paths so the live data.json / embeddings.bin are never
// touched.
// ---------------------------------------------------------------------------

interface ScratchIndexStorage {
	read(): Promise<IndexedNote[]>;
	write(index: IndexedNote[]): Promise<void>;
	diskPaths: string[];
}

/** Mirrors the pre-migration shape: whole index, embeddings inline, one JSON.stringify/parse. */
class ScratchLegacyJsonStorage implements ScratchIndexStorage {
	readonly diskPaths: string[];

	constructor(private readonly adapter: DataAdapter, private readonly path: string) {
		this.diskPaths = [path];
	}

	async read(): Promise<IndexedNote[]> {
		if (!(await this.adapter.exists(this.path))) return [];
		const raw = await this.adapter.read(this.path);
		return (JSON.parse(raw) as { index: IndexedNote[] }).index;
	}

	async write(index: IndexedNote[]): Promise<void> {
		await this.adapter.write(this.path, JSON.stringify({index}));
	}
}

/** Mirrors ObsidianPluginDataIndexStorage: binary sidecar (embeddings) + slim JSON (meta). */
class ScratchBinaryStorage implements ScratchIndexStorage {
	readonly diskPaths: string[];

	constructor(
		private readonly adapter: DataAdapter,
		private readonly jsonPath: string,
		private readonly binPath: string,
	) {
		this.diskPaths = [jsonPath, binPath];
	}

	async read(): Promise<IndexedNote[]> {
		if (!(await this.adapter.exists(this.jsonPath)) || !(await this.adapter.exists(this.binPath))) {
			return [];
		}
		const meta = JSON.parse(await this.adapter.read(this.jsonPath)) as {
			index: ReturnType<typeof packIndexedNotesToV2>["index"];
			embeddingDim: number;
		};
		const decoded = decodeEmbeddings(await this.adapter.readBinary(this.binPath));
		if (decoded.dim !== meta.embeddingDim) return [];
		return unpackV2ToIndexedNotes(meta.index, decoded.embeddings, decoded.dim, decoded.count);
	}

	async write(index: IndexedNote[]): Promise<void> {
		const {index: v2, embeddings, dim} = packIndexedNotesToV2(index);
		const buffer = encodeEmbeddings(embeddings, dim);
		await this.adapter.writeBinary(this.binPath, buffer);
		await this.adapter.write(this.jsonPath, JSON.stringify({index: v2, embeddingDim: dim}));
	}
}

// ---------------------------------------------------------------------------
// Per-backend codec (in-memory serialize/deserialize, no disk)
// ---------------------------------------------------------------------------

interface Codec {
	name: string;
	/** Serialize the whole index to its persisted form; returns total byte length. */
	serialize(index: IndexedNote[]): { blob: unknown; bytes: number };
	deserialize(blob: unknown): IndexedNote[];
}

const jsonCodec: Codec = {
	name: "json (legacy)",
	serialize: (index) => {
		const blob = JSON.stringify({index});
		return {blob, bytes: new TextEncoder().encode(blob).length};
	},
	deserialize: (blob) => (JSON.parse(blob as string) as { index: IndexedNote[] }).index,
};

const binaryCodec: Codec = {
	name: "binary (current)",
	serialize: (index) => {
		const {index: v2, embeddings, dim} = packIndexedNotesToV2(index);
		const buffer = encodeEmbeddings(embeddings, dim);
		const json = JSON.stringify({index: v2, embeddingDim: dim});
		return {
			blob: {json, buffer, dim},
			bytes: new TextEncoder().encode(json).length + buffer.byteLength,
		};
	},
	deserialize: (blob) => {
		const {json, buffer, dim} = blob as { json: string; buffer: ArrayBuffer; dim: number };
		const meta = JSON.parse(json) as { index: ReturnType<typeof packIndexedNotesToV2>["index"] };
		const decoded = decodeEmbeddings(buffer);
		return unpackV2ToIndexedNotes(meta.index, decoded.embeddings, dim, decoded.count);
	},
};

// ---------------------------------------------------------------------------
// Reporting helpers
// ---------------------------------------------------------------------------

function row(cells: [string, number][]): string {
	return "  " + cells.map(([text, width]) => text.padStart(width)).join("");
}

// Prevents the JS engine from optimizing away the decode whose heap we measure.
let heapSink = 0;

async function totalFileSize(adapter: DataAdapter, paths: string[]): Promise<number> {
	let total = 0;
	for (const path of paths) {
		const stat = await adapter.stat(path);
		total += stat?.size ?? 0;
	}
	return total;
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

	const legacyJsonPath = normalizePath(`${opts.scratchDir}/index.bench.legacy.json`);
	const binaryJsonPath = normalizePath(`${opts.scratchDir}/index.bench.json`);
	const binaryBinPath = normalizePath(`${opts.scratchDir}/index.bench.bin`);

	log("════════════════════════════════════════════════════════════════");
	log("  Index storage comparison — legacy JSON vs binary sidecar");
	log(`  iterations=${iterations} warmup=${warmup} dim=${dim}`);
	log("════════════════════════════════════════════════════════════════");

	const codecs = [jsonCodec, binaryCodec];
	const backends: { name: string; storage: ScratchIndexStorage }[] = [
		{name: "json (legacy)", storage: new ScratchLegacyJsonStorage(opts.adapter, legacyJsonPath)},
		{name: "binary (current)", storage: new ScratchBinaryStorage(opts.adapter, binaryJsonPath, binaryBinPath)},
	];
	const allDiskPaths = [legacyJsonPath, binaryJsonPath, binaryBinPath];

	try {
		// --- Section 1: codec CPU + serialized size (in-memory) ------------
		log("");
		log("▸ Codec CPU + serialized size (in-memory, no disk)");
		log(
			row([
				["N", 8],
				["backend", 18],
				["serialize", 12],
				["deserialize", 13],
				["bytes", 12],
				["heapΔ", 10],
			]),
		);

		for (const n of sweepSizes) {
			const seed = makeSeedIndex(n, dim, mulberry32(0x5100 + n));
			for (const codec of codecs) {
				const {blob, bytes} = codec.serialize(seed);

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
						[codec.name, 18],
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
				["backend", 18],
				["write", 12],
				["read", 12],
				["diskBytes", 13],
			]),
		);

		for (const n of sweepSizes) {
			const seed = makeSeedIndex(n, dim, mulberry32(0x5200 + n));
			for (let i = 0; i < backends.length; i++) {
				const {name, storage} = backends[i];
				const writeMs = await measure(() => storage.write(seed), iterations, warmup);
				const readMs = await measure(async () => void (await storage.read()), iterations, warmup);
				const diskBytes = await totalFileSize(opts.adapter, storage.diskPaths);

				log(
					row([
						[i === 0 ? String(n) : "", 8],
						[name, 18],
						[ms(writeMs.median), 12],
						[ms(readMs.median), 12],
						[kb(diskBytes), 13],
					]),
				);
			}
		}

		log("");
		log("  Notes:");
		log("   • serialize/deserialize = JSON.stringify/parse (legacy) vs encodeEmbeddings/decodeEmbeddings");
		log("     + slim-JSON stringify/parse (binary) — the exact functions the real code path uses.");
		log("   • bytes/diskBytes = persisted payload (binary packs float32; legacy JSON writes float64 text,");
		log("     so its bytes should run close to 2x the binary payload for the embedding data alone).");
		log("   • deserialize returns IndexedNote[] with `embeddings: number[][]` either way (Array.from over");
		log("     the decoded Float32Array in the binary case), so parsed heap footprint is comparable —");
		log("     the storage win here is disk/serialized size and write/read I/O cost, not resident memory.");
		log("   • heap deltas are best-effort (no forced GC); read the trend, not absolutes.");
		log(`   • scratch files: ${allDiskPaths.join(", ")} (removed on completion).`);
	} finally {
		for (const path of allDiskPaths) {
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

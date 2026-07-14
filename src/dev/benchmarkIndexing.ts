/**
 * DEV-ONLY indexing benchmark.
 *
 * Measures the efficacy of the `indexNote` use case ({@link makeIndexNote}) under
 * realistic conditions: it drives the *real* embedder (the iframe transformer model)
 * and the *real* markdown extractor, but wires them to in-memory note source and
 * index storage so it never touches the user's vault or persisted plugin data.
 *
 * It reports, per the three questions we care about:
 *   1. Index-note cost & time   — full insert path (prepare + embed + store).
 *   2. Note-update cost & time   — changed-content path, plus the cheap unchanged
 *                                  (dedup hit) path.
 *   3. Memory footprint & complexity — how cost scales with vault size N.
 *
 * NOTE on storage fidelity: the in-memory storage reproduces exactly what
 * {@link JsonIndexedNoteRepository} + the plugin data store do on every write —
 * parse the whole index, rebuild it, and re-serialize the whole index (the O(N)
 * write amplification). It deliberately omits the raw disk-write latency of
 * Obsidian's `saveData()`, which is a roughly-constant cost on top of the
 * CPU/serialize cost measured here.
 *
 * This module is only ever reached behind an `if (__DEV__)` guard, so it is
 * tree-shaken out of production builds.
 */
import { IndexedNote, NoteIndexCandidate, RawNote, SimilaritySettings } from "../types";
import {
	EmbeddingPort,
	IndexRepository,
	IndexStorage,
	MarkdownTextExtractor,
	NoteSource,
	SettingsRepository,
} from "../ports";
import { JsonIndexedNoteRepository } from "../infra/index/jsonIndexedNoteRepository";
import { makeIndexNote } from "../app/indexNote";
import { makeEmbedText } from "../app/embedText";
import { makePrepareNoteForEmbedding } from "../app/prepareNoteForEmbedding";
import { DEFAULT_SETTINGS } from "../constants";
import { heapUsedMB, kb, makeSeedIndex, mulberry32, now, randomUnitEmbedding, ms, summarize } from "./benchmarkShared";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface BenchmarkOptions {
	embedder: EmbeddingPort;
	markdownTextExtractor: MarkdownTextExtractor;
	/** Where to print human-readable progress/results. Defaults to console.log. */
	log?: (message: string) => void;
	/** Measured iterations per scenario (after warmup). Default 5. */
	iterations?: number;
	/** Warmup iterations (not measured). Default 1. */
	warmup?: number;
	/** Vault size N used for the per-note-size scenarios. Default 500. */
	fixedIndexSize?: number;
	/** Note sizes (approx. markdown chars) exercised at the fixed vault size. */
	noteSizes?: { label: string; chars: number }[];
	/** Vault sizes swept to expose complexity / memory scaling. */
	sweepSizes?: number[];
	/** Note size (approx. chars) used during the complexity sweep. Default 1200. */
	sweepNoteChars?: number;
}

const DEFAULT_NOTE_SIZES = [
	{ label: "small", chars: 500 },
	{ label: "medium", chars: 2400 },
	{ label: "large", chars: DEFAULT_SETTINGS.maxExtractedChars }, // hits the chunk cap
];

const DEFAULT_SWEEP_SIZES = [0, 100, 500, 1000, 2000, 5000];

// ---------------------------------------------------------------------------
// Timing primitives
// ---------------------------------------------------------------------------

interface PhaseTimings {
	prepare: number;
	lookup: number;
	embed: number;
	store: number;
}

interface OpCounters {
	embedCalls: number;
	embedChars: number;
}

interface Sample {
	totalMs: number;
	prepareMs: number;
	lookupMs: number;
	embedMs: number;
	storeMs: number;
	otherMs: number;
	embedCalls: number;
	bytesWritten: number;
}

// ---------------------------------------------------------------------------
// In-memory adapters (faithful to the real JSON-backed stack, minus disk I/O)
// ---------------------------------------------------------------------------

class InMemoryIndexStorage implements IndexStorage {
	private serialized = "[]";
	bytesWritten = 0;
	bytesRead = 0;
	writeCount = 0;
	readCount = 0;

	async getAll(): Promise<IndexedNote[]> {
		this.readCount++;
		this.bytesRead += this.serialized.length;
		return JSON.parse(this.serialized) as IndexedNote[];
	}

	async rewrite(index: IndexedNote[]): Promise<void> {
		this.serialized = JSON.stringify(index);
		this.writeCount++;
		this.bytesWritten += this.serialized.length;
	}

	async flush(): Promise<void> {
	}

	async isEmpty(): Promise<boolean> {
		return this.serialized === "[]";
	}

	async needsRebuild(): Promise<boolean> {
		return false;
	}

	async readLegacy(): Promise<IndexedNote[] | null> {
		return null;
	}

	/** Replace the whole index without counting it as a measured write. */
	seed(notes: IndexedNote[]): void {
		this.serialized = JSON.stringify(notes);
	}

	get serializedBytes(): number {
		return this.serialized.length;
	}

	resetCounters(): void {
		this.bytesWritten = 0;
		this.bytesRead = 0;
		this.writeCount = 0;
		this.readCount = 0;
	}
}

class InMemoryNoteSource implements NoteSource {
	private notes = new Map<string, RawNote>();

	set(note: RawNote): void {
		this.notes.set(note.id, note);
	}

	async getNoteById(noteId: string): Promise<RawNote | null> {
		return this.notes.get(noteId) ?? null;
	}

	listIds(): string[] {
		return [...this.notes.keys()];
	}

	listIndexCandidates(): NoteIndexCandidate[] {
		return [...this.notes.keys()].map((id) => ({ id, modifiedAt: 0 }));
	}
}

class StaticSettingsRepository implements SettingsRepository {
	private settings: SimilaritySettings = { ...DEFAULT_SETTINGS };

	async get(): Promise<SimilaritySettings> {
		return this.settings;
	}

	async update(settings: SimilaritySettings): Promise<void> {
		this.settings = settings;
	}

	async updatePartial(patch: Partial<SimilaritySettings>): Promise<void> {
		this.settings = { ...this.settings, ...patch };
	}
}

// ---------------------------------------------------------------------------
// Synthetic data
// ---------------------------------------------------------------------------

const LOREM =
	("lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor " +
		"incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud " +
		"exercitation ullamco laboris nisi aliquip commodo consequat duis aute irure " +
		"reprehenderit voluptate velit esse cillum eu fugiat nulla pariatur excepteur sint")
		.split(" ");

function makeMarkdownBody(chars: number, rng: () => number): string {
	let body = "";
	while (body.length < chars) {
		const sentenceLength = 8 + Math.floor(rng() * 12);
		const words: string[] = [];
		for (let i = 0; i < sentenceLength; i++) {
			words.push(LOREM[Math.floor(rng() * LOREM.length)]);
		}
		body += words.join(" ") + ". ";
		if (rng() < 0.15) body += "\n\n";
	}
	return body.slice(0, chars);
}

function makeNote(id: string, chars: number, rng: () => number): RawNote {
	return {
		id,
		title: `Synthetic note ${id}`,
		markdown: `# Synthetic note\n\n${makeMarkdownBody(chars, rng)}`,
	};
}

// ---------------------------------------------------------------------------
// Instrumented use-case wiring
// ---------------------------------------------------------------------------

interface Harness {
	indexNote: (noteId: string) => Promise<unknown>;
	noteSource: InMemoryNoteSource;
	storage: InMemoryIndexStorage;
	repo: IndexRepository;
	timings: PhaseTimings;
	counters: OpCounters;
	reset(): void;
}

function buildHarness(opts: BenchmarkOptions): Harness {
	const timings: PhaseTimings = { prepare: 0, lookup: 0, embed: 0, store: 0 };
	const counters: OpCounters = { embedCalls: 0, embedChars: 0 };

	const storage = new InMemoryIndexStorage();
	const noteSource = new InMemoryNoteSource();
	const settingsRepo = new StaticSettingsRepository();
	const baseRepo = new JsonIndexedNoteRepository(storage);

	// Time findById (lookup) separately from upsert/remove (store).
	const repo: IndexRepository = {
		findById: async (id) => {
			const s = now();
			try {
				return await baseRepo.findById(id);
			} finally {
				timings.lookup += now() - s;
			}
		},
		upsert: async (note) => {
			const s = now();
			try {
				return await baseRepo.upsert(note);
			} finally {
				timings.store += now() - s;
			}
		},
		remove: async (id) => {
			const s = now();
			try {
				return await baseRepo.remove(id);
			} finally {
				timings.store += now() - s;
			}
		},
		upsertMany: (notes) => baseRepo.upsertMany(notes),
		listAll: () => baseRepo.listAll(),
		isEmpty: () => baseRepo.isEmpty(),
		rename: (oldId, newId) => baseRepo.rename(oldId, newId),
		flush: () => baseRepo.flush(),
	};

	const instrumentedEmbedder: EmbeddingPort = {
		embed: async (text, options) => {
			const s = now();
			try {
				return await opts.embedder.embed(text, options);
			} finally {
				timings.embed += now() - s;
				counters.embedCalls++;
				counters.embedChars += text.length;
			}
		},
		load: () => opts.embedder.load(),
		unload: () => opts.embedder.unload(),
	};

	const basePrepare = makePrepareNoteForEmbedding({
		noteSource,
		markdownTextExtractor: opts.markdownTextExtractor,
		settingsRepo,
	});
	const prepareNoteForEmbedding = async (noteId: string) => {
		const s = now();
		try {
			return await basePrepare(noteId);
		} finally {
			timings.prepare += now() - s;
		}
	};

	const indexNote = makeIndexNote({
		prepareNoteForEmbedding,
		embedText: makeEmbedText({ embedder: instrumentedEmbedder, settingsRepo }),
		indexRepo: repo,
		isIgnoredPath: async () => false,
	});

	return {
		indexNote,
		noteSource,
		storage,
		repo,
		timings,
		counters,
		reset() {
			timings.prepare = timings.lookup = timings.embed = timings.store = 0;
			counters.embedCalls = 0;
			counters.embedChars = 0;
			storage.resetCounters();
		},
	};
}

/** Run one measured `indexNote` call and capture the per-phase breakdown. */
async function runOnce(h: Harness, noteId: string): Promise<Sample> {
	h.reset();
	const start = now();
	await h.indexNote(noteId);
	const totalMs = now() - start;

	const { prepare, lookup, embed, store } = h.timings;
	return {
		totalMs,
		prepareMs: prepare,
		lookupMs: lookup,
		embedMs: embed,
		storeMs: store,
		otherMs: Math.max(0, totalMs - prepare - lookup - embed - store),
		embedCalls: h.counters.embedCalls,
		bytesWritten: h.storage.bytesWritten,
	};
}

async function collect(
	h: Harness,
	noteId: string,
	beforeEach: () => void,
	iterations: number,
	warmup: number,
): Promise<Sample[]> {
	for (let i = 0; i < warmup; i++) {
		beforeEach();
		await runOnce(h, noteId);
	}
	const samples: Sample[] = [];
	for (let i = 0; i < iterations; i++) {
		beforeEach();
		samples.push(await runOnce(h, noteId));
	}
	return samples;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function logSamples(log: (m: string) => void, label: string, samples: Sample[]): void {
	const total = summarize(samples.map((s) => s.totalMs));
	const prepare = summarize(samples.map((s) => s.prepareMs));
	const lookup = summarize(samples.map((s) => s.lookupMs));
	const embed = summarize(samples.map((s) => s.embedMs));
	const store = summarize(samples.map((s) => s.storeMs));
	const other = summarize(samples.map((s) => s.otherMs));
	const embedCalls = samples[0]?.embedCalls ?? 0;
	const bytes = samples[0]?.bytesWritten ?? 0;

	log(
		`  ${label.padEnd(28)} ` +
			`total ${ms(total.median)} (p95 ${ms(total.p95)})  |  ` +
			`prepare ${ms(prepare.median)}  lookup ${ms(lookup.median)}  ` +
			`embed ${ms(embed.median)}  store ${ms(store.median)}  other ${ms(other.median)}  |  ` +
			`embedCalls ${embedCalls}  wrote ${kb(bytes)}`,
	);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runIndexingBenchmark(opts: BenchmarkOptions): Promise<void> {
	const log = opts.log ?? ((m: string) => console.log(m));
	const iterations = opts.iterations ?? 5;
	const warmup = opts.warmup ?? 1;
	const fixedIndexSize = opts.fixedIndexSize ?? 500;
	const noteSizes = opts.noteSizes ?? DEFAULT_NOTE_SIZES;
	const sweepSizes = opts.sweepSizes ?? DEFAULT_SWEEP_SIZES;
	const sweepNoteChars = opts.sweepNoteChars ?? 1200;

	const rng = mulberry32(0x5eed);

	log("════════════════════════════════════════════════════════════════");
	log("  Indexing benchmark (indexNote) — real embedder, in-memory store");
	log(`  iterations=${iterations} warmup=${warmup} fixedIndexSize=${fixedIndexSize}`);
	log("════════════════════════════════════════════════════════════════");

	await opts.embedder.load();

	// Probe the real embedding dimensionality so synthetic seeds match.
	const probe = await opts.embedder.embed("benchmark probe text", {maxOverlapPercent: 0});
	const dim = probe?.[0]?.length ?? 384;
	log(`  embedding dimensionality: ${dim}`);

	const h = buildHarness(opts);

	// --- Scenario 1: index / update / unchanged across note sizes ----------
	log("");
	log(`▸ Per-note cost by size, at vault size N=${fixedIndexSize}`);
	log("  (median timings; phase split: prepare→lookup→embed→store→other)");

	for (const size of noteSizes) {
		const seed = makeSeedIndex(fixedIndexSize, dim, mulberry32(0x1000 + size.chars));

		// Insert: fresh id each iteration, vault re-seeded to keep N constant.
		const insertId = "bench-insert.md";
		h.noteSource.set(makeNote(insertId, size.chars, rng));
		const insertSamples = await collect(
			h,
			insertId,
			() => h.storage.seed(seed),
			iterations,
			warmup,
		);

		// Update (changed content): target pre-exists with a different hash, so
		// every call re-embeds and replaces.
		const updateId = "bench-update.md";
		const seedWithTarget = [
			...seed,
			{
				id: updateId,
				embedding: randomUnitEmbedding(dim, rng),
				contentHash: "deadbeef",
				updatedAt: new Date(0).toISOString(),
			},
		];
		h.noteSource.set(makeNote(updateId, size.chars, rng));
		const updateSamples = await collect(
			h,
			updateId,
			() => h.storage.seed(seedWithTarget),
			iterations,
			warmup,
		);

		// Unchanged (dedup hit): index once for real to capture the correct hash,
		// then re-index identical content — no embedding, just lookup + prepare.
		const unchangedId = "bench-unchanged.md";
		h.noteSource.set(makeNote(unchangedId, size.chars, rng));
		h.storage.seed(seed);
		await h.indexNote(unchangedId); // establish the matching hash (not measured)
		const settledIndex = await h.repo.listAll();
		const unchangedSamples = await collect(
			h,
			unchangedId,
			() => h.storage.seed(settledIndex),
			iterations,
			warmup,
		);

		log("");
		log(`  ── note size: ${size.label} (~${size.chars} chars) ──`);
		logSamples(log, "index (insert)", insertSamples);
		logSamples(log, "update (changed)", updateSamples);
		logSamples(log, "update (unchanged/dedup)", unchangedSamples);
	}

	// --- Scenario 2: complexity & memory vs vault size N -------------------
	log("");
	log(`▸ Complexity & memory vs vault size N (note ~${sweepNoteChars} chars)`);
	log("  insert cost should grow ~linearly with N (full-index rewrite per upsert)");
	log("");
	log(
		"  " +
			"N".padStart(6) +
			"insertTotal".padStart(14) +
			"storeMs".padStart(11) +
			"embedMs".padStart(11) +
			"indexBytes".padStart(13) +
			"floatBytes".padStart(13) +
			"heapMB".padStart(10),
	);

	const sweepId = "bench-sweep.md";
	h.noteSource.set(makeNote(sweepId, sweepNoteChars, rng));

	for (const n of sweepSizes) {
		const seed = makeSeedIndex(n, dim, mulberry32(0x2000 + n));
		h.storage.seed(seed);
		const indexBytes = h.storage.serializedBytes;
		const floatBytes = n * dim * 8; // JS numbers are 64-bit
		const heap = heapUsedMB();

		const samples = await collect(h, sweepId, () => h.storage.seed(seed), iterations, warmup);
		const total = summarize(samples.map((s) => s.totalMs));
		const store = summarize(samples.map((s) => s.storeMs));
		const embed = summarize(samples.map((s) => s.embedMs));

		log(
			"  " +
				String(n).padStart(6) +
				ms(total.median).padStart(14) +
				ms(store.median).padStart(11) +
				ms(embed.median).padStart(11) +
				kb(indexBytes).padStart(13) +
				kb(floatBytes).padStart(13) +
				(heap === null ? "n/a" : heap.toFixed(1)).padStart(10),
		);
	}

	log("");
	log("  Notes:");
	log("   • store time is the O(N) full-index rewrite (parse + serialize whole index).");
	log("   • indexBytes = serialized index size; floatBytes = raw embedding payload.");
	log("   • heapMB is best-effort (no forced GC); read the trend, not absolutes.");
	log("   • disk-write latency of saveData() is excluded — add a roughly-constant cost.");
	log("");
	log("✓ Benchmark complete.");
}

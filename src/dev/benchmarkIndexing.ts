/**
 * DEV-ONLY indexing benchmark.
 *
 * Measures the efficacy of the `indexNote` use case ({@link makeIndexNote}) under
 * realistic conditions: it drives the *real* embedder (the iframe transformer model)
 * and the *real* markdown extractor, but wires them to in-memory note source and
 * index storage so it never touches the user's vault or persisted plugin data.
 *
 * It reports, per the questions we care about:
 *   1. Index-note cost & time   — full insert path (prepare + embed + store).
 *   2. Note-update cost & time   — changed-content path, plus the cheap unchanged
 *                                  (dedup hit) path.
 *   3. Memory footprint & complexity — how cost scales with vault size N.
 *   4. Retrieve cost, time & memory — getSimilarNotes over the whole index: the
 *                                  hot path (query note already indexed → listAll +
 *                                  cosine over N) swept across N, plus the cold
 *                                  path (text query that must embed first). Each
 *                                  retrieve records its per-phase split and the
 *                                  transient heap growth to materialize the index.
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
import { makeEmbedChunks, makeEmbedText } from "../app/embedText";
import { makeGetSimilarNotes, GetSimilarNotesUseCase } from "../app/getSimilarNotes";
import { makePrepareNoteForEmbedding } from "../app/prepareNoteForEmbedding";
import { DEFAULT_SETTINGS } from "../constants";
import {
	heapUsedMB,
	kb,
	makeSeedIndex,
	ms,
	mulberry32,
	now,
	randomUnitEmbedding,
	summarize,
} from "./benchmarkShared";

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
	/** Vault sizes swept for the retrieve (getSimilarNotes) benchmark. Defaults to sweepSizes. */
	retrieveSweepSizes?: number[];
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
	/** Time spent in repo.listAll() — the whole-index deserialize on the retrieve path. */
	listAll: number;
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

/** One measured `getSimilarNotes` call. */
interface RetrieveSample {
	totalMs: number;
	/** findById to fetch the query note's stored embedding (hot path only). */
	lookupMs: number;
	/** listAll — deserialize the whole index into memory. */
	listAllMs: number;
	/** embed the query text (cold path only; 0 on the hot path). */
	embedMs: number;
	/** cosine scoring + filter + sort + slice over N candidates. */
	scoreMs: number;
	/** Heap growth observed across the call (best-effort; see heapUsedMB). */
	heapDeltaMB: number | null;
	/** Number of results returned (sanity check that scoring actually ran). */
	results: number;
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

	async isEmpty(): Promise<boolean> {
		return this.serialized === "[]";
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
// Synthetic data (markdown bodies; embedding/index helpers live in benchmarkShared)
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
	getSimilarNotes: GetSimilarNotesUseCase;
	noteSource: InMemoryNoteSource;
	storage: InMemoryIndexStorage;
	repo: IndexRepository;
	timings: PhaseTimings;
	counters: OpCounters;
	reset(): void;
}

function buildHarness(opts: BenchmarkOptions): Harness {
	const timings: PhaseTimings = { prepare: 0, lookup: 0, embed: 0, store: 0, listAll: 0 };
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
		listAll: async () => {
			const s = now();
			try {
				return await baseRepo.listAll();
			} finally {
				timings.listAll += now() - s;
			}
		},
		isEmpty: () => baseRepo.isEmpty(),
		rename: (oldId, newId) => baseRepo.rename(oldId, newId),
	};

	const instrumentedEmbedder: EmbeddingPort = {
		embed: async (text) => {
			const s = now();
			try {
				return await opts.embedder.embed(text);
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
		embedChunks: makeEmbedChunks({ embedder: instrumentedEmbedder }),
		indexRepo: repo,
		isIgnoredPath: async () => false,
	});

	const getSimilarNotes = makeGetSimilarNotes({
		indexRepo: repo,
		embedText: makeEmbedText({ embedder: instrumentedEmbedder }),
		embedChunks: makeEmbedChunks({ embedder: instrumentedEmbedder }),
		prepareNoteForEmbedding,
	});

	return {
		indexNote,
		getSimilarNotes,
		noteSource,
		storage,
		repo,
		timings,
		counters,
		reset() {
			timings.prepare = timings.lookup = timings.embed = timings.store = timings.listAll = 0;
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

/**
 * Run one measured `getSimilarNotes` call and capture the retrieve-phase
 * breakdown plus heap growth across the call.
 *
 * `query` selects the retrieve path:
 *   - `{ noteId }` present in the index → hot path (reuses the stored embedding,
 *     so lookup + listAll + score only; no embedding cost).
 *   - `{ text }`                        → cold path (embeds the query text first).
 */
async function runRetrieveOnce(
	h: Harness,
	query: { noteId?: string; text?: string },
): Promise<RetrieveSample> {
	h.reset();
	const heapBefore = heapUsedMB();
	const start = now();
	const results = await h.getSimilarNotes({ ...query, limit: 10 });
	const totalMs = now() - start;
	const heapAfter = heapUsedMB();

	const { lookup, listAll, embed } = h.timings;
	return {
		totalMs,
		lookupMs: lookup,
		listAllMs: listAll,
		embedMs: embed,
		scoreMs: Math.max(0, totalMs - lookup - listAll - embed),
		heapDeltaMB: heapBefore === null || heapAfter === null ? null : heapAfter - heapBefore,
		results: results.length,
	};
}

async function collectRetrieve(
	h: Harness,
	query: { noteId?: string; text?: string },
	beforeEach: () => void,
	iterations: number,
	warmup: number,
): Promise<RetrieveSample[]> {
	for (let i = 0; i < warmup; i++) {
		beforeEach();
		await runRetrieveOnce(h, query);
	}
	const samples: RetrieveSample[] = [];
	for (let i = 0; i < iterations; i++) {
		beforeEach();
		samples.push(await runRetrieveOnce(h, query));
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

function logRetrieveSamples(log: (m: string) => void, label: string, samples: RetrieveSample[]): void {
	const total = summarize(samples.map((s) => s.totalMs));
	const lookup = summarize(samples.map((s) => s.lookupMs));
	const listAll = summarize(samples.map((s) => s.listAllMs));
	const embed = summarize(samples.map((s) => s.embedMs));
	const score = summarize(samples.map((s) => s.scoreMs));
	const heapDeltas = samples.map((s) => s.heapDeltaMB).filter((v): v is number => v !== null);
	const heap = heapDeltas.length ? summarize(heapDeltas) : null;
	const results = samples[0]?.results ?? 0;

	log(
		`  ${label.padEnd(28)} ` +
			`total ${ms(total.median)} (p95 ${ms(total.p95)})  |  ` +
			`lookup ${ms(lookup.median)}  listAll ${ms(listAll.median)}  ` +
			`embed ${ms(embed.median)}  score ${ms(score.median)}  |  ` +
			`heapΔ ${heap === null ? "n/a" : `${heap.median.toFixed(2)}MB`}  results ${results}`,
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
	const retrieveSweepSizes = opts.retrieveSweepSizes ?? sweepSizes;

	const rng = mulberry32(0x5eed);

	log("════════════════════════════════════════════════════════════════");
	log("  Indexing benchmark (indexNote) — real embedder, in-memory store");
	log(`  iterations=${iterations} warmup=${warmup} fixedIndexSize=${fixedIndexSize}`);
	log("════════════════════════════════════════════════════════════════");

	await opts.embedder.load();

	// Probe the real embedding dimensionality so synthetic seeds match.
	const probe = await opts.embedder.embed("benchmark probe text");
	const dim = probe?.length ?? 384;
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

	// --- Scenario 3: retrieve cost & memory vs vault size N ----------------
	log("");
	log("▸ Retrieve cost & memory vs vault size N (getSimilarNotes, hot path)");
	log("  hot path = query note already indexed → listAll + cosine over N, no embed");
	log("  time and heapΔ should both grow ~linearly with N (whole index materialized).");
	log("");

	const retrieveQueryId = "bench-retrieve.md";
	for (const n of retrieveSweepSizes) {
		// Seed N random notes plus the query note, so findById(queryId) hits the
		// stored-embedding fast path and scoring runs over the full N+1 index.
		const seed = makeSeedIndex(n, dim, mulberry32(0x3000 + n));
		const seedWithQuery = [
			...seed,
			{
				id: retrieveQueryId,
				embedding: randomUnitEmbedding(dim, rng),
				contentHash: "cafef00d",
				updatedAt: new Date(0).toISOString(),
			},
		];
		const samples = await collectRetrieve(
			h,
			{ noteId: retrieveQueryId },
			() => h.storage.seed(seedWithQuery),
			iterations,
			warmup,
		);
		logRetrieveSamples(log, `N=${n}`, samples);
	}

	// Cold path (text query → embed first) at the fixed vault size, to capture
	// the embed-inclusive retrieve latency a from-scratch query pays.
	log("");
	log(`▸ Retrieve cold path (text query, embeds first) at N=${fixedIndexSize}`);
	{
		const seed = makeSeedIndex(fixedIndexSize, dim, mulberry32(0x4000));
		const queryText = makeMarkdownBody(sweepNoteChars, mulberry32(0x4001));
		const samples = await collectRetrieve(
			h,
			{ text: queryText },
			() => h.storage.seed(seed),
			iterations,
			warmup,
		);
		logRetrieveSamples(log, "text query", samples);
	}

	log("");
	log("  Notes:");
	log("   • hot-path retrieve embeds nothing — cost is listAll (deserialize) + cosine scoring.");
	log("   • cold-path retrieve adds the query embed cost on top of the same listAll + score.");
	log("   • heapΔ is the transient allocation to materialize the whole index (best-effort).");
	log("");
	log("✓ Benchmark complete.");
}

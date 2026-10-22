import { Embedding, EmbeddingModelId, IndexedNote, NoteChunk, RelatedNote, SCHEMA_VERSION, SearchMode } from "../../types";
import { EmbeddingFileStore, ModelIndexMetaStore } from "../../ports";
import { DecodedEmbeddings, decodeEmbeddings, encodeEmbeddings } from "../../core/vector/codec";
import { packForStorage, unpackFromStorage } from "../../core/vector/packing";
import { checkIndexHealth, MetaState, SidecarState } from "../../core/rules/health";
import { makeNoteScorer, rankSimilarNotes, ScoredNote, selectTopScores } from "../../core/vector/similarity";
import { scaleScore, similarityTier } from "../../core/vector/similarityTier";
import { EMBEDDING_MODELS } from "../../constants";

export type IndexRename = { oldId: string; newId: string };

export type IndexEntry = {
	id: string;
	updatedAt: string;
	contentHash: string;
	truncated?: boolean;
};

export type IndexStats = {
	notes: number;
	chunks: number;
	dim: number;
};

export type QueryOptions = {
	excludeId?: string;
	limit?: number;
	minScore?: number;
	mode?: SearchMode;
};

export interface IndexHandle {
	readonly modelId: EmbeddingModelId;

	get(noteId: string): IndexedNote | null;

	has(noteId: string): boolean;

	isEmpty(): boolean;

	stats(): IndexStats;

	entries(): IndexEntry[];

	ids(): string[];

	query(queryChunks: Embedding[], options?: QueryOptions): RelatedNote[];

	queryNote(noteId: string, options?: Omit<QueryOptions, "excludeId">): RelatedNote[] | null;

	upsert(note: IndexedNote): void;

	remove(noteId: string): boolean;

	removeMany(noteIds: string[]): boolean;

	rename(oldId: string, newId: string): boolean;

	renameMany(renames: IndexRename[]): boolean;

	flush(): Promise<void>;

	close(): Promise<void>;
}

export type IndexFiles = {
	metaStore: ModelIndexMetaStore;
	binaryStore: EmbeddingFileStore;
};

const DEFAULT_WRITE_THROTTLE_MS = 1000;

type NoteQueryMemo = {
	noteId: string;
	query: NoteChunk[];
	mode: SearchMode;
	scores: Map<string, { chunks: NoteChunk[]; score: number }>;
};

class ResidentIndex implements IndexHandle {
	private readonly byId = new Map<string, IndexedNote>();
	private dirty = false;
	private timer: number | null = null;
	private writing: Promise<void> = Promise.resolve();
	private closed = false;
	private memo: NoteQueryMemo | null = null;

	constructor(
		readonly modelId: EmbeddingModelId,
		private readonly dim: number,
		private readonly files: IndexFiles,
		private readonly throttleMs: number,
		notes: IndexedNote[],
	) {
		for (const note of notes) this.byId.set(note.id, note);
	}

	get(noteId: string): IndexedNote | null {
		return this.byId.get(noteId) ?? null;
	}

	has(noteId: string): boolean {
		return this.byId.has(noteId);
	}

	isEmpty(): boolean {
		return this.byId.size === 0;
	}

	stats(): IndexStats {
		let chunks = 0;
		for (const note of this.byId.values()) chunks += note.chunks.length;
		return {notes: this.byId.size, chunks, dim: this.dim};
	}

	entries(): IndexEntry[] {
		const out: IndexEntry[] = [];
		for (const note of this.byId.values()) {
			out.push({id: note.id, updatedAt: note.updatedAt, contentHash: note.contentHash, truncated: note.truncated});
		}
		return out;
	}

	ids(): string[] {
		return [...this.byId.keys()];
	}

	query(queryChunks: Embedding[], options: QueryOptions = {}): RelatedNote[] {
		const {scoreNull, minScore} = EMBEDDING_MODELS[this.modelId];
		return this.withTiers(rankSimilarNotes(queryChunks, [...this.byId.values()], scoreNull, {...options, minScore: options.minScore ?? minScore}));
	}

	queryNote(noteId: string, options: Omit<QueryOptions, "excludeId"> = {}): RelatedNote[] | null {
		const queryNote = this.byId.get(noteId);
		if (!queryNote) return null;

		const mode = options.mode ?? "granular";
		const previous = this.memo;
		const reusable = previous !== null
			&& previous.noteId === noteId && previous.query === queryNote.chunks && previous.mode === mode;
		const known = reusable ? previous.scores : new Map<string, { chunks: NoteChunk[]; score: number }>();

		let score: ((candidateChunks: Embedding[]) => number) | null = null;
		const scores = new Map<string, { chunks: NoteChunk[]; score: number }>();
		const ranked: ScoredNote[] = [];
		for (const note of this.byId.values()) {
			if (note.id === noteId) continue;

			const hit = known.get(note.id);
			let value: number;
			if (hit && hit.chunks === note.chunks) {
				value = hit.score;
			} else {
				score ??= makeNoteScorer(mode, queryNote.chunks.map((chunk) => chunk.embedding), EMBEDDING_MODELS[this.modelId].scoreNull);
				value = score(note.chunks.map((chunk) => chunk.embedding));
			}
			scores.set(note.id, {chunks: note.chunks, score: value});
			ranked.push({id: note.id, score: value});
		}

		this.memo = {noteId, query: queryNote.chunks, mode, scores};
		return this.withTiers(selectTopScores(ranked, {...options, minScore: options.minScore ?? EMBEDDING_MODELS[this.modelId].minScore}));
	}

	private withTiers(results: ScoredNote[]): RelatedNote[] {
		const {tierThresholds} = EMBEDDING_MODELS[this.modelId];
		return results.map((result) => ({
			...result,
			tier: similarityTier(result.score, tierThresholds),
			scaledScore: scaleScore(result.score, tierThresholds),
		}));
	}

	upsert(note: IndexedNote): void {
		this.byId.set(note.id, note);
		this.markDirty();
	}

	remove(noteId: string): boolean {
		return this.removeMany([noteId]);
	}

	removeMany(noteIds: string[]): boolean {
		let changed = false;
		for (const noteId of noteIds) {
			if (this.byId.delete(noteId)) changed = true;
		}
		if (changed) this.markDirty();
		return changed;
	}

	rename(oldId: string, newId: string): boolean {
		return this.renameMany([{oldId, newId}]);
	}

	renameMany(renames: IndexRename[]): boolean {
		let changed = false;
		for (const {oldId, newId} of renames) {
			if (oldId === newId) continue;
			const existing = this.byId.get(oldId);
			if (!existing) continue;

			this.byId.delete(oldId);
			this.byId.set(newId, {...existing, id: newId});
			changed = true;
		}
		if (changed) this.markDirty();
		return changed;
	}

	async flush(): Promise<void> {
		this.cancelTimer();

		const run = this.writing.then(async () => {
			if (!this.dirty) return;
			this.dirty = false;
			try {
				await this.writeNow();
			} catch (error) {
				this.dirty = true;
				throw error;
			}
		});

		this.writing = run.catch(() => undefined);
		return run;
	}

	async close(): Promise<void> {
		this.closed = true;
		this.memo = null;
		await this.flush();
	}

	async persist(): Promise<void> {
		this.dirty = true;
		await this.flush();
	}

	private markDirty(): void {
		if (this.closed) return;
		this.dirty = true;
		if (this.timer != null) return;

		this.timer = window.setTimeout(() => {
			this.timer = null;
			void this.flush().catch((error) => {
				console.error("[Similarity] Failed to write the index:", error);
			});
		}, this.throttleMs);
	}

	private cancelTimer(): void {
		if (this.timer == null) return;
		window.clearTimeout(this.timer);
		this.timer = null;
	}

	private async writeNow(): Promise<void> {
		const {metadata, embeddings, dim} = packForStorage([...this.byId.values()], this.dim);
		const buffer = encodeEmbeddings(embeddings, dim);

		// Binary first, then JSON. Dying in between leaves schemaVersion stale, so a
		// re-run deterministically reproduces the identical binary — no temp files needed.
		await this.files.binaryStore.write(this.modelId, buffer);
		await this.files.metaStore.write(this.modelId, {
			schemaVersion: SCHEMA_VERSION,
			embeddingDim: dim,
			index: metadata,
		});
	}
}

type SidecarRead = {
	state: SidecarState;
	decoded: DecodedEmbeddings | null;
};

async function readSidecar(files: IndexFiles, modelId: EmbeddingModelId): Promise<SidecarRead> {
	const buffer = await files.binaryStore.read(modelId);
	if (!buffer) return {state: {status: "missing"}, decoded: null};

	try {
		const decoded = decodeEmbeddings(buffer);
		return {
			state: {status: "ok", dim: decoded.dim, count: decoded.count, byteLength: buffer.byteLength},
			decoded,
		};
	} catch {
		return {state: {status: "corrupt"}, decoded: null};
	}
}

async function readMeta(files: IndexFiles, modelId: EmbeddingModelId): Promise<MetaState> {
	try {
		const data = await files.metaStore.read(modelId);
		return data ? {status: "ok", data} : {status: "missing"};
	} catch {
		return {status: "corrupt"};
	}
}

export async function openIndex(
	files: IndexFiles,
	modelId: EmbeddingModelId,
	options: { throttleMs?: number } = {},
): Promise<IndexHandle> {
	const dim = EMBEDDING_MODELS[modelId].dim;
	const throttleMs = options.throttleMs ?? DEFAULT_WRITE_THROTTLE_MS;

	const meta = await readMeta(files, modelId);
	const {state, decoded} = await readSidecar(files, modelId);

	const health = checkIndexHealth({meta, sidecar: state});

	if (health.status === "unusable") {
		console.warn(`[Similarity] Index discarded (${health.reason}) — rebuilding from scratch.`);
		const handle = new ResidentIndex(modelId, dim, files, throttleMs, []);
		await handle.persist();
		return handle;
	}

	const notes = decoded
		? unpackFromStorage({
			metadata: health.validEntries,
			embeddings: decoded.embeddings,
			dim: decoded.dim,
			chunkCount: decoded.count,
		})
		: [];

	const handle = new ResidentIndex(modelId, dim, files, throttleMs, notes);

	if (health.droppedIds.length > 0) {
		console.warn(
			`[Similarity] Dropped ${health.droppedIds.length} damaged index entries; they will be re-indexed.`,
		);
		await handle.persist();
	}

	return handle;
}

import { EmbeddingModelId, IndexingQueueSnapshot } from "../types";
import { SettingsRepository, StatusReporter, Vault } from "../ports";
import { Priority, PriorityQueue } from "../core/util/priorityQueue";
import { KeyedDebouncer } from "../core/util/debounce";
import { isUnderFolder, repathToFolder } from "../core/rules/folderPath";
import { EmbeddingEngine, EngineStatus } from "../embedding/engine";
import { IndexHandle } from "./store/indexHandle";
import { IndexRegistry } from "./store/indexRegistry";
import { makeBuildIndexSyncPlan } from "./syncPlan";
import { IndexNoteUseCase, makeIndexNote } from "../app/indexNote";
import { GetNoteTextUseCase } from "../app/getNoteText";
import { IsIgnoredPath } from "../app/isIgnoredPath";

export type Unsubscribe = () => void;

export type IndexerDeps = {
	engine: EmbeddingEngine;
	registry: IndexRegistry;
	vault: Vault;
	getNoteText: GetNoteTextUseCase;
	isIgnoredPath: IsIgnoredPath;
	settingsRepo: SettingsRepository;
	status: StatusReporter;
	onChanged: () => void;
	editDebounceMs?: number;
};

const DEFAULT_EDIT_DEBOUNCE_MS = 1100;

export class Indexer {
	private readonly foreground = new PriorityQueue();
	private backlogOrder: string[] = [];
	private backlogCursor = 0;
	private backlogRemaining = new Set<string>();

	private readonly pendingIds = new Set<string>();
	private readonly awaited = new Map<string, { resolve: () => void; promise: Promise<void> }>();
	private readonly runningIds = new Set<string>();
	private readonly failedIds = new Set<string>();
	private processed = 0;
	private failed = 0;
	private fatalError: string | undefined;

	private loop: Promise<void> | null = null;
	private inFlight: Promise<void> | null = null;
	private drainedWaiters: Array<() => void> = [];
	private paused = true;
	private disposed = false;
	private emitScheduled = false;

	private indexNote: IndexNoteUseCase | null = null;
	private handle: IndexHandle | null = null;
	private switching: Promise<void> = Promise.resolve();
	private syncing: Promise<void> | null = null;
	private syncAgain = false;

	private readonly debouncer: KeyedDebouncer<string>;
	private readonly listeners = new Set<(status: IndexingQueueSnapshot) => void>();
	private readonly unsubscribeEngine: Unsubscribe;

	constructor(private readonly deps: IndexerDeps) {
		this.debouncer = new KeyedDebouncer<string>(deps.editDebounceMs ?? DEFAULT_EDIT_DEBOUNCE_MS);
		this.unsubscribeEngine = deps.engine.subscribe((status) => this.onEngineStatus(status));
	}

	index(): IndexHandle | null {
		return this.handle;
	}

	status(): IndexingQueueSnapshot {
		const inFlight = this.runningIds.size;
		return {
			isRunning: this.pendingIds.size > 0 || inFlight > 0,
			currentNoteId: this.runningIds.values().next().value,
			pending: this.pendingIds.size,
			processed: this.processed,
			total: this.processed + this.pendingIds.size + inFlight,
			failed: this.failed,
			fatalError: this.fatalError,
			failedIds: [...this.failedIds],
		};
	}

	subscribe(listener: (status: IndexingQueueSnapshot) => void): Unsubscribe {
		this.listeners.add(listener);
		listener(this.status());
		return () => {
			this.listeners.delete(listener);
		};
	}

	async useModel(modelId: EmbeddingModelId): Promise<void> {
		const open = this.deps.registry.use(modelId).then((handle) => {
			this.handle = handle;
			this.indexNote = makeIndexNote({
				getNoteText: this.deps.getNoteText,
				index: handle,
				isIgnoredPath: this.deps.isIgnoredPath,
				embedText: (text) => this.deps.engine.embed(text, {priority: "low"}),
			});
		});

		this.switching = open.then(() => undefined, () => undefined);
		await open;
		this.deps.onChanged();
	}

	syncAll(): Promise<void> {
		if (this.syncing) {
			this.syncAgain = true;
			return this.syncing;
		}
		this.syncing = this.runSync().finally(() => {
			this.syncing = null;
		});
		return this.syncing;
	}

	view(noteId: string): void {
		void this.handleView(noteId).catch((error) => {
			console.error("[Similarity] Indexing viewed note failed", error);
		});
	}

	edited(noteId: string): void {
		this.debouncer.schedule(noteId, async () => {
			try {
				await this.submit(noteId, "medium");
			} catch (error) {
				console.error("[Similarity] Indexing edited note failed", error);
				return;
			}
			this.deps.onChanged();
		});
	}

	remove(noteId: string): void {
		this.debouncer.cancel(noteId);
		this.forget(noteId);
		this.handle?.remove(noteId);
		this.deps.onChanged();
	}

	removeFolder(folderPath: string): void {
		const noteIds = this.idsUnder(folderPath);
		if (noteIds.length === 0) return;

		for (const noteId of noteIds) {
			this.debouncer.cancel(noteId);
			this.forget(noteId);
		}
		this.handle?.removeMany(noteIds);
		this.deps.onChanged();
	}

	rename(oldId: string, newId: string): void {
		this.debouncer.cancel(oldId);
		this.forget(oldId);
		this.handle?.rename(oldId, newId);
		this.deps.onChanged();
	}

	renameFolder(oldPath: string, newPath: string): void {
		const renames = this.idsUnder(oldPath).map((oldId) => ({
			oldId,
			newId: repathToFolder(oldId, oldPath, newPath),
		}));
		if (renames.length === 0) return;

		for (const {oldId} of renames) {
			this.debouncer.cancel(oldId);
			this.forget(oldId);
		}
		this.handle?.renameMany(renames);
		this.deps.onChanged();
	}

	flush(): Promise<void> {
		return this.handle?.flush() ?? Promise.resolve();
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		this.unsubscribeEngine();
		this.debouncer.cancel();
		this.clearQueues();
		await this.inFlight;
		this.listeners.clear();
	}

	private onEngineStatus(status: EngineStatus): void {
		if (this.disposed) return;

		// The index follows the model. On an "error" the engine has no model at all,
		// so we keep whatever index is open — reads still work without an embedder.
		if ((status.kind === "loading" || status.kind === "ready") && this.handle?.modelId !== status.modelId) {
			void this.useModel(status.modelId).catch((error) => {
				console.error(`[Similarity] Failed to open the ${status.modelId} index:`, error);
			});
		}

		if (status.kind !== "ready") {
			this.paused = true;
			this.clearQueues();
			return;
		}

		void this.switching.then(() => {
			if (this.disposed) return;
			this.paused = false;
			this.ensureRunning();
			void this.syncAll();
		});
	}

	private async handleView(noteId: string): Promise<void> {
		if (this.pendingIds.has(noteId) || this.backlogRemaining.has(noteId)) {
			await this.submit(noteId, "medium");
			return;
		}
		if (this.handle?.has(noteId)) return;
		await this.submit(noteId, "medium");
	}

	private submit(noteId: string, priority: Priority): Promise<void> {
		if (this.disposed) return Promise.resolve();

		this.backlogRemaining.delete(noteId);
		this.watch(noteId);
		this.foreground.enqueue(noteId, priority);
		this.scheduleEmit();
		this.ensureRunning();

		return this.awaitNote(noteId);
	}

	private awaitNote(noteId: string): Promise<void> {
		const existing = this.awaited.get(noteId);
		if (existing) return existing.promise;

		let resolve!: () => void;
		const promise = new Promise<void>((res) => {
			resolve = res;
		});
		this.awaited.set(noteId, {resolve, promise});
		return promise;
	}

	private releaseNote(noteId: string): void {
		const waiter = this.awaited.get(noteId);
		if (!waiter) return;
		this.awaited.delete(noteId);
		waiter.resolve();
	}

	private async runSync(): Promise<void> {
		do {
			this.syncAgain = false;
			try {
				await this.switching;
				const handle = this.handle;
				if (!handle) return;

				const plan = makeBuildIndexSyncPlan({
					vault: this.deps.vault,
					index: handle,
					settingsRepo: this.deps.settingsRepo,
				})();

				handle.removeMany(plan.idsToRemoveFromIndex);
				this.setBacklog(plan.idsToSeed);
				await this.whenDrained();
			} catch (error) {
				console.error("[Similarity] Failed to refresh indexing queue:", error);
			}
		} while (this.syncAgain);
	}

	private setBacklog(noteIds: string[]): void {
		if (this.disposed) return;

		this.backlogOrder = noteIds;
		this.backlogCursor = 0;
		this.backlogRemaining = new Set(noteIds);
		for (const queued of this.pendingIds) this.backlogRemaining.delete(queued);

		for (const noteId of noteIds) this.watch(noteId);
		this.scheduleEmit();
		this.deps.onChanged();
		this.ensureRunning();
	}

	private whenDrained(): Promise<void> {
		if (this.disposed || (this.loop === null && !this.hasWork())) return Promise.resolve();
		return new Promise<void>((resolve) => {
			this.drainedWaiters.push(resolve);
		});
	}

	private ensureRunning(): void {
		if (this.disposed || this.paused || this.loop || !this.hasWork()) return;

		this.loop = this.runLoop().finally(() => {
			this.loop = null;
			this.ensureRunning();
		});
	}

	private async runLoop(): Promise<void> {
		try {
			while (!this.disposed && !this.paused) {
				const noteId = this.takeNext();
				if (noteId === null) return;
				await this.processNote(noteId);
			}
		} catch (error) {
			if (this.disposed) return;
			this.fatalError = error instanceof Error ? error.message : String(error);
			this.deps.status.update("Indexing paused after an error. Try restarting Obsidian.", null);
			this.scheduleEmit();
			console.error("[Similarity] Indexing stopped:", error);
		} finally {
			if (!this.hasWork()) {
				void this.flush().catch((error) => {
					console.error("[Similarity] Failed to write the index:", error);
				});
				this.releaseDrainedWaiters();
			}
		}
	}

	private takeNext(): string | null {
		const queued = this.foreground.take();
		if (queued) return queued;

		while (this.backlogCursor < this.backlogOrder.length) {
			const noteId = this.backlogOrder[this.backlogCursor++];
			if (this.backlogRemaining.delete(noteId)) return noteId;
		}

		this.backlogOrder = [];
		this.backlogCursor = 0;
		this.backlogRemaining.clear();
		return null;
	}

	private async processNote(noteId: string): Promise<void> {
		const indexNote = this.indexNote;
		if (!indexNote) return;

		this.pendingIds.delete(noteId);
		this.runningIds.add(noteId);
		this.scheduleEmit();

		const run = indexNote(noteId);
		this.inFlight = run.then(() => undefined, () => undefined);

		try {
			await run;
			this.settle(noteId);
		} catch (error) {
			this.settle(noteId, error);
			console.error(`[Similarity] Indexing failed for ${noteId}:`, error);
		} finally {
			this.inFlight = null;
			this.releaseNote(noteId);
		}
	}

	private watch(noteId: string): void {
		if (this.isIdle()) this.resetCounters();
		if (this.failedIds.delete(noteId)) {
			this.failed--;
			this.processed--;
		}
		if (!this.runningIds.has(noteId)) this.pendingIds.add(noteId);
	}

	private forget(noteId: string): void {
		this.pendingIds.delete(noteId);
		this.backlogRemaining.delete(noteId);
		this.foreground.remove(noteId);
		this.releaseNote(noteId);
	}

	private settle(noteId: string, error?: unknown): void {
		this.runningIds.delete(noteId);
		this.processed++;
		if (error !== undefined) {
			this.failedIds.add(noteId);
			this.failed++;
		}
		this.scheduleEmit();
	}

	private idsUnder(folderPath: string): string[] {
		return (this.handle?.ids() ?? []).filter((id) => isUnderFolder(id, folderPath));
	}

	private clearQueues(): void {
		this.foreground.clear();
		this.backlogOrder = [];
		this.backlogCursor = 0;
		this.backlogRemaining.clear();
		this.pendingIds.clear();
		for (const noteId of [...this.awaited.keys()]) this.releaseNote(noteId);
		this.scheduleEmit();
		this.releaseDrainedWaiters();
	}

	private hasWork(): boolean {
		return !this.foreground.isEmpty || this.backlogCursor < this.backlogOrder.length;
	}

	private isIdle(): boolean {
		return this.pendingIds.size === 0 && this.runningIds.size === 0;
	}

	private resetCounters(): void {
		this.processed = 0;
		this.failed = 0;
		this.fatalError = undefined;
	}

	private releaseDrainedWaiters(): void {
		const waiters = this.drainedWaiters;
		this.drainedWaiters = [];
		for (const resolve of waiters) resolve();
	}

	private scheduleEmit(): void {
		if (this.emitScheduled) return;
		this.emitScheduled = true;
		queueMicrotask(() => {
			this.emitScheduled = false;
			const status = this.status();
			for (const listener of this.listeners) listener(status);
		});
	}
}

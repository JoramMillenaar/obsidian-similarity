import { Plugin } from "obsidian";
import { KeyedDebouncer } from "./domain/debouncer";
import { ThrottledIndexStorage } from "./domain/throttledIndexStorage";
import { ObsidianStatusBar } from "./infra/obsidian/obsidianStatusBar";
import { ObsidianMarkdownTextExtractor } from "./infra/obsidian/obsidianMarkdownTextExtractor";
import { ObsidianNoteSource } from "./infra/obsidian/obsidianNoteSource";
import { ObsidianPluginDataIndexStorage } from "./infra/obsidian/obsidianStorage";
import { BinaryEmbeddingFileStore } from "./infra/obsidian/binaryEmbeddingFileStore";
import { EmbeddingProvider } from "./infra/embedder/embeddingProvider";
import { JsonIndexedNoteRepository } from "./infra/index/jsonIndexedNoteRepository";
import { IndexNoteUseCase, makeIndexNote } from "./app/indexNote";
import { makeMigrateStore, MigrateStoreUseCase } from "./app/makeMigrateStore";
import { GetSimilarNotesUseCase, makeGetSimilarNotes } from "./app/getSimilarNotes";
import { InsertWikilinkAtCursorUseCase, makeInsertWikilinkAtCursor } from "./app/insertWikilinkAtCursor";
import { makeSyncIndexToVault, SyncIndexToVaultUseCase } from "./app/syncIndexToVault";
import { makeEmbedTextChunks } from "./app/embedText";
import { makeCollapseIndexToAverage } from "./app/collapseIndexToAverage";
import {
	EmbeddingPort,
	IndexRepository,
	IndexStorage,
	MarkdownTextExtractor,
	NoteSource,
	SettingsRepository,
	StatusReporter,
} from "./ports";
import { ObsidianPluginDataStore } from "./infra/obsidian/obsidianPluginDataStore";
import { ObsidianSettingsRepository } from "./infra/obsidian/obsidianSettings";
import { IsIgnoredPath, makeIsIgnoredPath } from "./app/isIgnoredPath";
import { makeUpdateSettings, UpdateSettingsUseCase } from "./app/updateSettings";
import {
	IsInitialIndexCompletedUseCase,
	makeIsInitialIndexCompleted,
	makeMarkInitialIndexCompleted,
	MarkInitialIndexCompletedUseCase,
} from "./app/initialIndexState";
import { ObsidianActiveEditor } from "./infra/obsidian/obsidianActiveEditor";
import { makePrepareNoteForEmbedding, PrepareNoteForEmbeddingUseCase } from "./app/prepareNoteForEmbedding";
import {
	AwaitIndexedNoteUseCase,
	BumpIndexPriorityUseCase,
	GetIndexingStateUseCase,
	makeIndexingCoordinator,
	StartOrRefreshIndexSyncUseCase,
	SubscribeIndexingStateUseCase,
} from "./app/indexingCoordinator";

/** Minimum spacing between full index disk writes (data.json + embeddings.bin). */
const INDEX_WRITE_THROTTLE_MS = 1000;

/**
 * Application container and composition root.
 * Owns concrete infrastructure adapters, wires use cases, and releases runtime resources.
 */
export class AppContainer {
	readonly status: StatusReporter;
	readonly noteSource: NoteSource;
	readonly markdownTextExtractor: MarkdownTextExtractor;
	readonly indexStorage: IndexStorage;
	readonly embedder: EmbeddingPort;
	readonly indexRepo: IndexRepository;
	readonly settingsRepo: SettingsRepository;
	readonly migrateStore: MigrateStoreUseCase;

	readonly indexNote: IndexNoteUseCase;
	readonly prepareNoteForEmbedding: PrepareNoteForEmbeddingUseCase;
	readonly getSimilarNotes: GetSimilarNotesUseCase;
	readonly insertWikilinkAtCursor: InsertWikilinkAtCursorUseCase;
	readonly syncIndexToVault: SyncIndexToVaultUseCase;
	readonly startOrRefreshIndexSync: StartOrRefreshIndexSyncUseCase;
	readonly bumpIndexPriority: BumpIndexPriorityUseCase;
	readonly awaitIndexedNote: AwaitIndexedNoteUseCase;
	readonly subscribeIndexingState: SubscribeIndexingStateUseCase;
	readonly getIndexingState: GetIndexingStateUseCase;
	readonly isIgnoredPath: IsIgnoredPath;
	readonly updateSettings: UpdateSettingsUseCase;
	readonly isInitialIndexCompleted: IsInitialIndexCompletedUseCase;
	readonly markInitialIndexCompleted: MarkInitialIndexCompletedUseCase;

	readonly upsertDebouncer: KeyedDebouncer<string>;

	private readonly unloadIndexingCoordinator: () => void;

	constructor(plugin: Plugin) {
		this.status = new ObsidianStatusBar(plugin);
		this.noteSource = new ObsidianNoteSource(plugin);
		this.markdownTextExtractor = new ObsidianMarkdownTextExtractor(plugin);
		const storage = new ObsidianPluginDataStore(plugin);
		const binaryEmbeddingStore = new BinaryEmbeddingFileStore(plugin);
		this.indexStorage = new ThrottledIndexStorage(
			new ObsidianPluginDataIndexStorage(storage, binaryEmbeddingStore),
			INDEX_WRITE_THROTTLE_MS,
		);
		this.migrateStore = makeMigrateStore({indexStorage: this.indexStorage});
		this.embedder = new EmbeddingProvider();
		this.indexRepo = new JsonIndexedNoteRepository(this.indexStorage);
		this.settingsRepo = new ObsidianSettingsRepository(storage);
		const embedTextChunks = makeEmbedTextChunks({
			embedder: this.embedder,
			settingsRepo: this.settingsRepo,
		});
		const collapseIndexToAverage = makeCollapseIndexToAverage({indexRepo: this.indexRepo});
		const activeEditor = new ObsidianActiveEditor(plugin);

		this.isIgnoredPath = makeIsIgnoredPath({
			settingsRepo: this.settingsRepo,
		});

		this.prepareNoteForEmbedding = makePrepareNoteForEmbedding({
			noteSource: this.noteSource,
			markdownTextExtractor: this.markdownTextExtractor,
			settingsRepo: this.settingsRepo,
		});

		this.indexNote = makeIndexNote({
			prepareNoteForEmbedding: this.prepareNoteForEmbedding,
			embedTextChunks,
			indexRepo: this.indexRepo,
			settingsRepo: this.settingsRepo,
			isIgnoredPath: this.isIgnoredPath,
		});

		this.getSimilarNotes = makeGetSimilarNotes({
			indexRepo: this.indexRepo,
			embedTextChunks,
			prepareNoteForEmbedding: this.prepareNoteForEmbedding,
		});

		this.insertWikilinkAtCursor = makeInsertWikilinkAtCursor({
			activeEditor,
			noteSource: this.noteSource,
		});

		const indexingCoordinator = makeIndexingCoordinator({
			noteSource: this.noteSource,
			indexRepo: this.indexRepo,
			settingsRepo: this.settingsRepo,
			indexNote: this.indexNote,
		});

		this.syncIndexToVault = makeSyncIndexToVault({
			startOrRefreshSync: indexingCoordinator.startOrRefreshSync,
			subscribe: indexingCoordinator.subscribe,
		});

		this.startOrRefreshIndexSync = indexingCoordinator.startOrRefreshSync;
		this.bumpIndexPriority = indexingCoordinator.bumpPriority;
		this.awaitIndexedNote = indexingCoordinator.awaitNote;
		this.subscribeIndexingState = indexingCoordinator.subscribe;
		this.getIndexingState = indexingCoordinator.getSnapshot;
		this.unloadIndexingCoordinator = indexingCoordinator.unload;

		this.upsertDebouncer = new KeyedDebouncer<string>(1100);

		this.updateSettings = makeUpdateSettings({
			settingsRepo: this.settingsRepo,
			indexStorage: this.indexStorage,
			startOrRefreshIndexSync: this.startOrRefreshIndexSync,
			collapseIndexToAverage,
		});
		this.isInitialIndexCompleted = makeIsInitialIndexCompleted({settingsRepo: this.settingsRepo});
		this.markInitialIndexCompleted = makeMarkInitialIndexCompleted({settingsRepo: this.settingsRepo});
	}

	async shutdown(): Promise<void> {
		this.unloadIndexingCoordinator();
		this.upsertDebouncer.cancel();
		await this.indexStorage.flush().catch((error) => {
			console.error("[Similarity] Failed to flush index on shutdown:", error);
		});
		this.embedder.unload();
		this.status.clear();
	}
}

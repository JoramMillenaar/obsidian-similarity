import { normalizePath, Plugin } from "obsidian";
import { KeyedDebouncer } from "./domain/debouncer";
import { ObsidianStatusBar } from "./infra/obsidian/obsidianStatusBar";
import { ObsidianMarkdownTextExtractor } from "./infra/obsidian/obsidianMarkdownTextExtractor";
import { ObsidianNoteSource } from "./infra/obsidian/obsidianNoteSource";
import { ObsidianPluginDataIndexStorage } from "./infra/obsidian/obsidianStorage";
import { BinaryVaultIndexStorage } from "./infra/index/binaryVaultIndexStorage";
import { IoDbIndexStorage } from "./infra/index/iodbStorage";
import { SwitchableIndexStorage } from "./infra/index/switchableIndexStorage";
import { EmbeddingProvider } from "./infra/embedder/embeddingProvider";
import { JsonIndexedNoteRepository } from "./infra/index/jsonIndexedNoteRepository";
import { IndexNoteUseCase, makeIndexNote } from "./app/indexNote";
import { GetSimilarNotesUseCase, makeGetSimilarNotes } from "./app/getSimilarNotes";
import { InsertWikilinkAtCursorUseCase, makeInsertWikilinkAtCursor } from "./app/insertWikilinkAtCursor";
import { makeSyncIndexToVault, SyncIndexToVaultUseCase } from "./app/syncIndexToVault";
import { makeEmbedChunks, makeEmbedText } from "./app/embedText";
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
import { makeMigrateIndexBackend, MigrateIndexBackendUseCase } from "./app/migrateIndexBackend";
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

/**
 * Application container and composition root.
 * Owns concrete infrastructure adapters, wires use cases, and releases runtime resources.
 */
export class AppContainer {
	readonly status: StatusReporter;
	readonly noteSource: NoteSource;
	readonly markdownTextExtractor: MarkdownTextExtractor;
	readonly indexStorage: IndexStorage;
	readonly migrateIndexBackend: MigrateIndexBackendUseCase;
	readonly embedder: EmbeddingPort;
	readonly indexRepo: IndexRepository;
	readonly settingsRepo: SettingsRepository;

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
	private readonly switchableIndexStorage: SwitchableIndexStorage;

	constructor(plugin: Plugin) {
		this.status = new ObsidianStatusBar(plugin);
		this.noteSource = new ObsidianNoteSource(plugin);
		this.markdownTextExtractor = new ObsidianMarkdownTextExtractor(plugin);
		const storage = new ObsidianPluginDataStore(plugin);
		const jsonIndexStorage = new ObsidianPluginDataIndexStorage(storage);
		const pluginDir = plugin.manifest.dir
			?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`;
		const binaryIndexStorage = new BinaryVaultIndexStorage(
			plugin.app.vault.adapter,
			normalizePath(`${pluginDir}/index.bin`),
		);
		const iodbIndexStorage = new IoDbIndexStorage(
			plugin.app.vault.adapter,
			normalizePath(pluginDir),
		);
		// Defaults to "json"; kept in sync with the persisted setting via
		// syncIndexBackend() during plugin initialization.
		this.switchableIndexStorage = new SwitchableIndexStorage(
			{json: jsonIndexStorage, binary: binaryIndexStorage, iodb: iodbIndexStorage},
			"json",
		);
		this.indexStorage = this.switchableIndexStorage;
		this.migrateIndexBackend = makeMigrateIndexBackend({storage: this.switchableIndexStorage});
		this.embedder = new EmbeddingProvider();
		const embedText = makeEmbedText({embedder: this.embedder});
		const embedChunks = makeEmbedChunks({embedder: this.embedder});
		this.indexRepo = new JsonIndexedNoteRepository(this.indexStorage);
		this.settingsRepo = new ObsidianSettingsRepository(storage);
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
			embedChunks,
			indexRepo: this.indexRepo,
			isIgnoredPath: this.isIgnoredPath,
		});

		this.getSimilarNotes = makeGetSimilarNotes({
			indexRepo: this.indexRepo,
			embedText,
			embedChunks,
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
			migrateIndexBackend: this.migrateIndexBackend,
			getActiveBackend: () => this.switchableIndexStorage.getActive(),
		});
		this.isInitialIndexCompleted = makeIsInitialIndexCompleted({settingsRepo: this.settingsRepo});
		this.markInitialIndexCompleted = makeMarkInitialIndexCompleted({settingsRepo: this.settingsRepo});
	}

	/**
	 * Aligns the active index storage backend with the persisted setting.
	 * Must run before any index access so reads/writes hit the right store.
	 */
	async syncIndexBackend(): Promise<void> {
		const settings = await this.settingsRepo.get();
		this.switchableIndexStorage.setActive(settings.indexBackend);
	}

	shutdown(): void {
		this.unloadIndexingCoordinator();
		this.upsertDebouncer.cancel();
		this.embedder.unload();
		this.status.clear();
	}
}

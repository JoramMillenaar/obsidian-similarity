import { Plugin } from "obsidian";
import { KeyedDebouncer } from "./domain/debouncer";
import { ThrottledIndexStorage } from "./domain/throttledIndexStorage";
import { ObsidianStatusBar } from "./infra/obsidian/obsidianStatusBar";
import { ObsidianMarkdownTextExtractor } from "./infra/obsidian/obsidianMarkdownTextExtractor";
import { ObsidianNoteSource } from "./infra/obsidian/obsidianNoteSource";
import { ObsidianIndexStorage } from "./infra/obsidian/obsidianIndexStorage";
import { BinaryEmbeddingFileStore } from "./infra/obsidian/binaryEmbeddingFileStore";
import { ObsidianModelIndexMetaStore } from "./infra/obsidian/obsidianModelIndexMetaStore";
import { LegacyEmbeddingFileStore } from "./infra/obsidian/legacyEmbeddingFileStore";
import { ReloadableEmbedder } from "./infra/embedder/reloadableEmbedder";
import { JsonIndexedNoteRepository } from "./infra/index/jsonIndexedNoteRepository";
import { IndexNoteUseCase, makeIndexNote } from "./app/indexNote";
import { GetSimilarNotesUseCase, makeGetSimilarNotes } from "./app/getSimilarNotes";
import { InsertWikilinkAtCursorUseCase, makeInsertWikilinkAtCursor } from "./app/insertWikilinkAtCursor";
import { makeEmbedText } from "./app/embedText";
import {
	EmbeddingFileStore,
	EmbeddingPort,
	IndexRepository,
	MarkdownTextExtractor,
	ModelIndexMetaStore,
	NoteSource,
	SettingsRepository,
	SimilarityView,
	StatusReporter,
} from "./ports";
import { ObsidianSimilarityView } from "./infra/obsidian/obsidianSimilarityView";
import { ObsidianPluginDataStore } from "./infra/obsidian/obsidianPluginDataStore";
import { ObsidianSettingsRepository } from "./infra/obsidian/obsidianSettings";
import { IsIgnoredPath, makeIsIgnoredPath } from "./app/isIgnoredPath";
import { makeUpdateSettings, UpdateSettingsUseCase } from "./app/updateSettings";
import { ObsidianActiveEditor } from "./infra/obsidian/obsidianActiveEditor";
import { GetIndexingStateUseCase, IndexingProgress, SubscribeIndexingStateUseCase } from "./app/indexingProgress";
import { makeSynchronizeIndex, SynchronizeIndexUseCase } from "./app/synchronizeIndex";
import { GetNoteTextUseCase, makeGetNoteText } from "./app/getNoteText";
import { makeBuildIndexSyncPlan } from "./app/buildIndexSyncPlan";
import { LiveNoteSync, makeLiveNoteSync } from "./app/liveNoteSync";
import { EmbeddingQueue } from "./app/embeddingQueue";
import { ChangeEmbeddingModelUseCase, makeChangeEmbeddingModel } from "./app/changeEmbeddingModel";
import { makeRunLegacyMigrations, RunLegacyMigrationsUseCase } from "./app/legacyMigrations";

const INDEX_WRITE_THROTTLE_MS = 1000;

export class AppContainer {
	readonly status: StatusReporter;
	readonly noteSource: NoteSource;
	readonly markdownTextExtractor: MarkdownTextExtractor;
	readonly pluginDataStore: ObsidianPluginDataStore;
	readonly modelIndexMetaStore: ModelIndexMetaStore;
	readonly embeddingFileStore: EmbeddingFileStore;
	readonly legacyEmbeddingFileStore: LegacyEmbeddingFileStore;
	readonly indexStorage: ThrottledIndexStorage;
	readonly embedder: EmbeddingPort;
	readonly indexRepo: IndexRepository;
	readonly settingsRepo: SettingsRepository;
	readonly embeddingQueue: EmbeddingQueue;
	readonly similarityView: SimilarityView;
	readonly liveNoteSync: LiveNoteSync;
	readonly upsertDebouncer: KeyedDebouncer<string>;

	readonly runLegacyMigrations: RunLegacyMigrationsUseCase;
	readonly indexNote: IndexNoteUseCase;
	readonly getNoteText: GetNoteTextUseCase;
	readonly getSimilarNotes: GetSimilarNotesUseCase;
	readonly insertWikilinkAtCursor: InsertWikilinkAtCursorUseCase;
	readonly synchronizeIndex: SynchronizeIndexUseCase;
	readonly subscribeIndexingState: SubscribeIndexingStateUseCase;
	readonly getIndexingState: GetIndexingStateUseCase;
	readonly isIgnoredPath: IsIgnoredPath;
	readonly updateSettings: UpdateSettingsUseCase;
	readonly changeEmbeddingModel: ChangeEmbeddingModelUseCase;

	private readonly unloadEmbeddingQueue: () => void;
	private readonly disposeIndexingProgress: () => void;

	constructor(plugin: Plugin) {
		this.status = new ObsidianStatusBar(plugin);
		this.noteSource = new ObsidianNoteSource(plugin);
		this.markdownTextExtractor = new ObsidianMarkdownTextExtractor(plugin);
		this.pluginDataStore = new ObsidianPluginDataStore(plugin);
		this.modelIndexMetaStore = new ObsidianModelIndexMetaStore(plugin);
		this.embeddingFileStore = new BinaryEmbeddingFileStore(plugin);
		this.legacyEmbeddingFileStore = new LegacyEmbeddingFileStore(plugin);
		this.settingsRepo = new ObsidianSettingsRepository(this.pluginDataStore);
		this.indexStorage = new ThrottledIndexStorage(
			new ObsidianIndexStorage(this.modelIndexMetaStore, this.embeddingFileStore, this.settingsRepo),
			INDEX_WRITE_THROTTLE_MS,
		);
		this.embedder = new ReloadableEmbedder();
		this.indexRepo = new JsonIndexedNoteRepository(this.indexStorage);
		const activeEditor = new ObsidianActiveEditor(plugin);
		this.similarityView = new ObsidianSimilarityView(plugin);

		this.embeddingQueue = new EmbeddingQueue();
		const queueState = new IndexingProgress();
		const embedText = makeEmbedText({
			embedder: this.embedder,
			settingsRepo: this.settingsRepo,
			queue: this.embeddingQueue
		})

		this.embeddingQueue.subscribe((event) => {
			if (event.type === "drained") return this.indexStorage.flush();
			if (event.type === "stopped") queueState.reportFatalError(event.error);
		});

		this.runLegacyMigrations = makeRunLegacyMigrations({
			pluginDataStore: this.pluginDataStore,
			modelIndexStore: this.modelIndexMetaStore,
			embeddingFileStore: this.embeddingFileStore,
			legacyEmbeddingFileStore: this.legacyEmbeddingFileStore,
		});

		this.isIgnoredPath = makeIsIgnoredPath({
			settingsRepo: this.settingsRepo,
		});

		this.getNoteText = makeGetNoteText({
			noteSource: this.noteSource,
			markdownTextExtractor: this.markdownTextExtractor,
			settingsRepo: this.settingsRepo,
		});

		this.indexNote = makeIndexNote({
			getNoteText: this.getNoteText,
			indexRepo: this.indexRepo,
			isIgnoredPath: this.isIgnoredPath,
			embedText
		});

		this.getSimilarNotes = makeGetSimilarNotes({
			indexRepo: this.indexRepo,
			embedText,
			getNoteText: this.getNoteText,
		});

		this.insertWikilinkAtCursor = makeInsertWikilinkAtCursor({
			activeEditor,
			noteSource: this.noteSource,
		});

		const buildIndexSyncPlan = makeBuildIndexSyncPlan({
			noteSource: this.noteSource,
			indexRepo: this.indexRepo,
			settingsRepo: this.settingsRepo,
		});

		this.synchronizeIndex = makeSynchronizeIndex({
			indexRepo: this.indexRepo,
			indexNote: this.indexNote,
			buildIndexSyncPlan,
			progress: queueState,
		});

		this.subscribeIndexingState = queueState.subscribeIndexingState;
		this.getIndexingState = queueState.getSnapshot;
		this.unloadEmbeddingQueue = this.embeddingQueue.unload;
		this.disposeIndexingProgress = queueState.dispose;

		this.upsertDebouncer = new KeyedDebouncer<string>(1100);

		this.liveNoteSync = makeLiveNoteSync({
			indexRepo: this.indexRepo,
			indexNote: this.indexNote,
			updateDebouncer: this.upsertDebouncer,
		});

		this.updateSettings = makeUpdateSettings({
			settingsRepo: this.settingsRepo,
			indexStorage: this.indexStorage,
			synchronizeIndex: this.synchronizeIndex,
		});

		this.changeEmbeddingModel = makeChangeEmbeddingModel({
			embedder: this.embedder,
			settingsRepo: this.settingsRepo,
			indexStorage: this.indexStorage,
			queue: this.embeddingQueue,
			synchronizeIndex: this.synchronizeIndex,
			status: this.status,
		});
	}

	async shutdown(): Promise<void> {
		this.unloadEmbeddingQueue();
		this.disposeIndexingProgress();
		this.upsertDebouncer.cancel();
		await this.indexStorage.flush().catch((error) => {
			console.error("[Similarity] Failed to flush index on shutdown:", error);
		});
		this.embedder.unload();
		this.status.clear();
	}
}

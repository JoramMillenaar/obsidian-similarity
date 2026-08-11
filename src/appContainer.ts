import { Plugin } from "obsidian";
import { KeyedDebouncer } from "./domain/debouncer";
import { ThrottledIndexStorage } from "./domain/throttledIndexStorage";
import { ModelSession } from "./domain/modelSession";
import { ObsidianStatusBar } from "./infra/obsidian/obsidianStatusBar";
import { ObsidianMarkdownTextExtractor } from "./infra/obsidian/obsidianMarkdownTextExtractor";
import { ObsidianNoteSource } from "./infra/obsidian/obsidianNoteSource";
import { ObsidianIndexStorage } from "./infra/obsidian/obsidianIndexStorage";
import { BinaryEmbeddingFileStore } from "./infra/obsidian/binaryEmbeddingFileStore";
import { ObsidianModelIndexMetaStore } from "./infra/obsidian/obsidianModelIndexMetaStore";
import { LegacyEmbeddingFileStore } from "./infra/obsidian/legacyEmbeddingFileStore";
import { ReloadableEmbedder } from "./infra/embedder/reloadableEmbedder";
import { MonolithicIndexRepository } from "./infra/index/monolithicIndexRepository";
import { IndexNoteUseCase, makeIndexNote } from "./app/indexNote";
import { GetSimilarNotesUseCase, makeGetSimilarNotes } from "./app/getSimilarNotes";
import { InsertWikilinkAtCursorUseCase, makeInsertWikilinkAtCursor } from "./app/insertWikilinkAtCursor";
import { EmbedTextUseCase, makeEmbedText } from "./app/embedText";
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
import { IndexingWorker } from "./app/indexingWorker";
import { ChangeEmbeddingModelUseCase, makeChangeEmbeddingModel } from "./app/changeEmbeddingModel";
import { makeRunLegacyMigrations, RunLegacyMigrationsUseCase } from "./app/legacyMigrations";
import { DEFAULT_EMBEDDING_MODEL_ID } from "./constants";

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
	readonly modelSession: ModelSession;
	readonly indexRepo: IndexRepository;
	readonly settingsRepo: SettingsRepository;
	readonly indexingWorker: IndexingWorker;
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
			new ObsidianIndexStorage(this.modelIndexMetaStore, this.embeddingFileStore),
			INDEX_WRITE_THROTTLE_MS,
		);
		this.embedder = new ReloadableEmbedder();
		this.modelSession = new ModelSession(DEFAULT_EMBEDDING_MODEL_ID);
		this.indexRepo = new MonolithicIndexRepository(this.indexStorage, this.modelSession);
		const activeEditor = new ObsidianActiveEditor(plugin);
		this.similarityView = new ObsidianSimilarityView(plugin);

		const queueState = new IndexingProgress();
		const embedText = makeEmbedText({
			embedder: this.embedder,
			settingsRepo: this.settingsRepo,
		})

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

		this.indexingWorker = new IndexingWorker(this.indexNote);
		this.indexingWorker.subscribe(queueState.observe);
		this.indexingWorker.subscribe((event) => {
			if (event.type === "drained" || event.type === "cleared") return this.indexStorage.flush();
		});
		this.indexingWorker.subscribe((event) => {
			if (event.type === "seeded") return this.similarityView.refreshResults();
		})

		const embedQuery: EmbedTextUseCase = (text, maxChunkSize) =>
			this.indexingWorker.submitEmbed(() => embedText(text, maxChunkSize));

		this.getSimilarNotes = makeGetSimilarNotes({
			indexRepo: this.indexRepo,
			embedText: embedQuery,
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
			buildIndexSyncPlan,
			worker: this.indexingWorker,
		});

		this.subscribeIndexingState = queueState.subscribeIndexingState;
		this.getIndexingState = queueState.getSnapshot;
		this.disposeIndexingProgress = queueState.dispose;

		this.upsertDebouncer = new KeyedDebouncer<string>(1100);

		this.liveNoteSync = makeLiveNoteSync({
			indexRepo: this.indexRepo,
			requestIndex: (noteId, priority) => this.indexingWorker.submitNote(noteId, priority),
			promoteIndex: (noteId, priority) => this.indexingWorker.promote(noteId, priority),
			updateDebouncer: this.upsertDebouncer,
			onNoteUpdated: () => this.similarityView.refreshResults(),
		});

		this.updateSettings = makeUpdateSettings({
			settingsRepo: this.settingsRepo,
			indexStorage: this.indexStorage,
			synchronizeIndex: this.synchronizeIndex,
			modelSession: this.modelSession,
		});

		this.changeEmbeddingModel = makeChangeEmbeddingModel({
			embedder: this.embedder,
			worker: this.indexingWorker,
			settingsRepo: this.settingsRepo,
			indexStorage: this.indexStorage,
			synchronizeIndex: this.synchronizeIndex,
			status: this.status,
			modelSession: this.modelSession,
		});
	}

	async shutdown(): Promise<void> {
		this.indexingWorker.unload();
		this.embedder.unload();
		this.disposeIndexingProgress();
		this.upsertDebouncer.cancel();
		await this.indexStorage.flush().catch((error) => {
			console.error("[Similarity] Failed to flush index on shutdown:", error);
		});
		this.status.clear();
	}
}

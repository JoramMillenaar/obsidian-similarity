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
import { GetSimilarNotesUseCase } from "./app/getSimilarNotes";
import { InsertWikilinkAtCursorUseCase, makeInsertWikilinkAtCursor } from "./app/insertWikilinkAtCursor";
import {
	EmbeddingFileStore,
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
import { SynchronizeIndexUseCase } from "./app/synchronizeIndex";
import { GetNoteTextUseCase, makeGetNoteText } from "./app/getNoteText";
import { IndexingWorker } from "./app/indexingWorker";
import { makeRunLegacyMigrations, RunLegacyMigrationsUseCase } from "./app/legacyMigrations";
import { makeBuildGeneration } from "./app/generation";
import { ModelSession } from "./app/modelSession";

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
	readonly modelSession: ModelSession;
	readonly settingsRepo: SettingsRepository;
	readonly indexingWorker: IndexingWorker;
	readonly similarityView: SimilarityView;
	readonly upsertDebouncer: KeyedDebouncer<string>;

	readonly runLegacyMigrations: RunLegacyMigrationsUseCase;
	readonly isIndexEmpty: () => Promise<boolean>;
	readonly getNoteText: GetNoteTextUseCase;
	readonly getSimilarNotes: GetSimilarNotesUseCase;
	readonly insertWikilinkAtCursor: InsertWikilinkAtCursorUseCase;
	readonly synchronizeIndex: SynchronizeIndexUseCase;
	readonly subscribeIndexingState: SubscribeIndexingStateUseCase;
	readonly getIndexingState: GetIndexingStateUseCase;
	readonly isIgnoredPath: IsIgnoredPath;
	readonly updateSettings: UpdateSettingsUseCase;

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
		const activeEditor = new ObsidianActiveEditor(plugin);
		this.similarityView = new ObsidianSimilarityView(plugin);

		const indexingProgress = new IndexingProgress();

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

		this.getSimilarNotes = (args) => this.modelSession.withGeneration((generation) => generation.getSimilarNotes(args));
		this.synchronizeIndex = () => this.modelSession.withGeneration((generation) => generation.synchronizeIndex());
		this.isIndexEmpty = () => this.modelSession.withGeneration((generation) => generation.indexRepo.isEmpty());

		this.indexingWorker = new IndexingWorker(
			(noteId) => this.modelSession.withGeneration((generation) => generation.indexNote(noteId)),
		);
		this.indexingWorker.subscribe(indexingProgress.observe);
		this.indexingWorker.subscribe((event) => {
			if (event.type === "drained" || event.type === "cleared") return this.indexStorage.flush();
		});
		this.indexingWorker.subscribe((event) => {
			if (event.type === "seeded") return this.similarityView.refreshResults();
		})

		this.insertWikilinkAtCursor = makeInsertWikilinkAtCursor({
			activeEditor,
			noteSource: this.noteSource,
		});

		this.subscribeIndexingState = indexingProgress.subscribeIndexingState;
		this.getIndexingState = indexingProgress.getSnapshot;
		this.disposeIndexingProgress = indexingProgress.dispose;

		this.upsertDebouncer = new KeyedDebouncer<string>(1100);

		const buildGeneration = makeBuildGeneration({
			indexStorage: this.indexStorage,
			noteSource: this.noteSource,
			getNoteText: this.getNoteText,
			isIgnoredPath: this.isIgnoredPath,
			settingsRepo: this.settingsRepo,
			worker: this.indexingWorker,
			upsertDebouncer: this.upsertDebouncer,
			onNoteUpdated: () => this.similarityView.refreshResults(),
		});

		this.modelSession = new ModelSession({
			buildGeneration,
			worker: this.indexingWorker,
			indexStorage: this.indexStorage,
			settingsRepo: this.settingsRepo,
			status: this.status,
		});

		this.updateSettings = makeUpdateSettings({
			settingsRepo: this.settingsRepo,
			indexStorage: this.indexStorage,
			modelSession: this.modelSession,
		});
	}

	async shutdown(): Promise<void> {
		this.indexingWorker.unload();
		this.modelSession.shutdown();
		this.disposeIndexingProgress();
		this.upsertDebouncer.cancel();
		await this.indexStorage.flush().catch((error) => {
			console.error("[Similarity] Failed to flush index on shutdown:", error);
		});
		this.status.clear();
	}
}

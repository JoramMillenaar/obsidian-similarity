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
import { GetSimilarNotesUseCase, makeGetSimilarNotes } from "./app/getSimilarNotes";
import { InsertWikilinkAtCursorUseCase, makeInsertWikilinkAtCursor } from "./app/insertWikilinkAtCursor";
import { makeEmbedText } from "./app/embedText";
import {
	EmbeddingPort,
	IndexRepository,
	IndexStorage,
	MarkdownTextExtractor,
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

const INDEX_WRITE_THROTTLE_MS = 1000;

export class AppContainer {
	readonly status: StatusReporter;
	readonly noteSource: NoteSource;
	readonly markdownTextExtractor: MarkdownTextExtractor;
	readonly indexStorage: IndexStorage;
	readonly embedder: EmbeddingPort;
	readonly indexRepo: IndexRepository;
	readonly settingsRepo: SettingsRepository;
	readonly embeddingQueue: EmbeddingQueue;
	readonly similarityView: SimilarityView;

	readonly indexNote: IndexNoteUseCase;
	readonly getNoteText: GetNoteTextUseCase;
	readonly getSimilarNotes: GetSimilarNotesUseCase;
	readonly insertWikilinkAtCursor: InsertWikilinkAtCursorUseCase;
	readonly synchronizeIndex: SynchronizeIndexUseCase;
	readonly subscribeIndexingState: SubscribeIndexingStateUseCase;
	readonly getIndexingState: GetIndexingStateUseCase;
	readonly isIgnoredPath: IsIgnoredPath;
	readonly updateSettings: UpdateSettingsUseCase;
	readonly liveNoteSync: LiveNoteSync;

	readonly upsertDebouncer: KeyedDebouncer<string>;

	private readonly unloadEmbeddingQueue: () => void;
	private readonly disposeIndexingProgress: () => void;

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
		this.embedder = new EmbeddingProvider();
		this.indexRepo = new JsonIndexedNoteRepository(this.indexStorage);
		this.settingsRepo = new ObsidianSettingsRepository(storage);
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
			if (event.type === "drained") return this.indexRepo.flush();
			if (event.type === "stopped") queueState.reportFatalError(event.error);
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

import { Platform, Plugin } from "obsidian";
import { ObsidianStatusBar } from "./obsidian/obsidianStatusBar";
import { ObsidianVault } from "./obsidian/obsidianVault";
import { BinaryEmbeddingFileStore } from "./obsidian/binaryEmbeddingFileStore";
import { ObsidianModelIndexMetaStore } from "./obsidian/obsidianModelIndexMetaStore";
import { LegacyEmbeddingFileStore } from "./obsidian/legacyEmbeddingFileStore";
import { ObsidianPluginDataStore } from "./obsidian/obsidianPluginDataStore";
import { ObsidianSettingsRepository } from "./obsidian/obsidianSettings";
import { ObsidianDeviceSettingsRepository } from "./obsidian/obsidianDeviceSettings";
import { makeLoadEmbeddingProvider } from "./embedding/host/workerProvider";
import {
	DeviceSettingsRepository,
	EmbeddingFileStore,
	ModelIndexMetaStore,
	SettingsRepository,
	StatusReporter,
	Vault,
} from "./ports";
import { EmbeddingEngine } from "./embedding/engine";
import { Indexer } from "./indexing/indexer";
import { IndexRegistry } from "./indexing/store/indexRegistry";
import { makeStatusHub, StatusHub } from "./status/statusHub";
import { GetSimilarNotesForNoteUseCase, makeGetSimilarNotesForNote } from "./search/getSimilarNotesForNote";
import { GetSimilarNotesForTextUseCase, makeGetSimilarNotesForText } from "./search/getSimilarNotesForText";
import { makeSimilarNotesFeed, SimilarNotesFeed } from "./search/similarNotesFeed";
import { makeSimilarSearchFeed, SimilarSearchFeed } from "./search/similarSearchFeed";
import { GetMatchedPassageUseCase, makeGetMatchedPassage } from "./search/getMatchedPassage";
import { KeywordSearch, makeKeywordSearch } from "./search/keywordSearch";
import { InsertWikilinkAtCursorUseCase, makeInsertWikilinkAtCursor } from "./app/insertWikilinkAtCursor";
import { IsIgnoredPath, makeIsIgnoredPath } from "./app/isIgnoredPath";
import { GetNoteTextUseCase, makeGetNoteText } from "./app/getNoteText";
import { makeUpdateSettings, UpdateSettingsUseCase } from "./app/updateSettings";
import { makeRemoveDeprecatedData, RemoveDeprecatedDataUseCase } from "./app/removeDeprecatedData";
import { makeSetModelDisabled, SetModelDisabledUseCase } from "./app/setModelDisabled";
import { collectDeviceInfo } from "./obsidian/obsidianDeviceInfo";
import { EnvironmentInfo } from "./core/feedback";
import { Reranker } from "./reranking/reranker";
import { makeRerankResults, RerankResultsUseCase } from "./search/rerankResults";
import { modelWorkerScript, startWorker } from "./workerScript";
import { RERANKER_IDLE_MS, RERANKER_MODEL } from "./constants";

const INDEX_WRITE_THROTTLE_MS = 1000;

export class AppContainer {
	readonly status: StatusReporter;
	readonly vault: Vault;
	readonly pluginDataStore: ObsidianPluginDataStore;
	readonly modelIndexMetaStore: ModelIndexMetaStore;
	readonly embeddingFileStore: EmbeddingFileStore;
	readonly legacyEmbeddingFileStore: LegacyEmbeddingFileStore;
	readonly settingsRepo: SettingsRepository;
	readonly deviceSettingsRepo: DeviceSettingsRepository;

	readonly engine: EmbeddingEngine;
	readonly indexer: Indexer;
	readonly statusHub: StatusHub;

	readonly similarNotesFeed: SimilarNotesFeed;
	readonly similarSearchFeed: SimilarSearchFeed;
	readonly insertWikilinkAtCursor: InsertWikilinkAtCursorUseCase;
	readonly updateSettings: UpdateSettingsUseCase;
	readonly setModelDisabled: SetModelDisabledUseCase;
	readonly removeDeprecatedData: RemoveDeprecatedDataUseCase;

	readonly getNoteText: GetNoteTextUseCase;
	readonly isIgnoredPath: IsIgnoredPath;
	readonly getSimilarNotesForNote: GetSimilarNotesForNoteUseCase;
	readonly getSimilarNotesForText: GetSimilarNotesForTextUseCase;
	readonly getMatchedPassage: GetMatchedPassageUseCase;
	readonly keywordSearch: KeywordSearch;
	readonly isIndexEmpty: () => Promise<boolean>;
	/** Desktop only: the cross-encoder that reorders text searches, too heavy for phones. */
	readonly reranking: { reranker: Reranker; rerankResults: RerankResultsUseCase } | null;

	private readonly registry: IndexRegistry;
	private readonly plugin: Plugin;

	constructor(plugin: Plugin) {
		this.plugin = plugin;
		this.status = new ObsidianStatusBar(plugin);
		this.vault = new ObsidianVault(plugin);
		this.pluginDataStore = new ObsidianPluginDataStore(plugin);
		this.modelIndexMetaStore = new ObsidianModelIndexMetaStore(plugin);
		this.embeddingFileStore = new BinaryEmbeddingFileStore(plugin);
		this.legacyEmbeddingFileStore = new LegacyEmbeddingFileStore(plugin);
		this.settingsRepo = new ObsidianSettingsRepository(this.pluginDataStore);
		this.deviceSettingsRepo = new ObsidianDeviceSettingsRepository(plugin);

		this.registry = new IndexRegistry(
			{metaStore: this.modelIndexMetaStore, binaryStore: this.embeddingFileStore},
			{throttleMs: INDEX_WRITE_THROTTLE_MS},
		);

		this.removeDeprecatedData = makeRemoveDeprecatedData({
			pluginDataStore: this.pluginDataStore,
			modelIndexStore: this.modelIndexMetaStore,
			embeddingFileStore: this.embeddingFileStore,
			legacyEmbeddingFileStore: this.legacyEmbeddingFileStore,
		});

		this.isIgnoredPath = makeIsIgnoredPath({settingsRepo: this.settingsRepo});

		this.getNoteText = makeGetNoteText({
			vault: this.vault,
			settingsRepo: this.settingsRepo,
		});

		this.engine = new EmbeddingEngine({
			loadEmbedder: makeLoadEmbeddingProvider({allowWebGpu: !Platform.isMobile}),
			status: this.status,
		});

		this.indexer = new Indexer({
			engine: this.engine,
			registry: this.registry,
			vault: this.vault,
			getNoteText: this.getNoteText,
			isIgnoredPath: this.isIgnoredPath,
			settingsRepo: this.settingsRepo,
			status: this.status,
			onChanged: () => this.similarNotesFeed.refresh(),
		});

		this.statusHub = makeStatusHub({engine: this.engine, indexer: this.indexer});

		this.getSimilarNotesForNote = async (args) => {
			const index = this.indexer.index();
			if (!index) return {items: [], truncated: false};
			return makeGetSimilarNotesForNote({index})(args);
		};

		this.keywordSearch = makeKeywordSearch({
			getIndex: () => this.indexer.index(),
			readMarkdown: async (noteId) => {
				const note = await this.vault.getNote(noteId);
				if (!note) throw new Error(`Could not find note with noteId '${noteId}'`);
				return `${note.title}\n${note.markdown.slice(0, this.settingsRepo.get().maxRawMarkdownChars)}`;
			},
			getNoteText: this.getNoteText,
		});

		this.getSimilarNotesForText = async (args) => {
			const index = this.indexer.index();
			if (!index) return [];
			return makeGetSimilarNotesForText({
				index,
				embed: (text) => this.engine.embed(text, {lane: "interactive"}),
				findKeywordHits: (text) => this.keywordSearch.find(text),
			})(args);
		};

		this.getMatchedPassage = makeGetMatchedPassage({getNoteText: this.getNoteText});

		if (Platform.isDesktopApp) {
			const reranker = new Reranker({
				config: RERANKER_MODEL,
				startWorker: () => startWorker(modelWorkerScript()),
				allowWebGpu: true,
				idleMs: RERANKER_IDLE_MS,
			});
			this.reranking = {
				reranker,
				rerankResults: makeRerankResults({
					getIndex: () => this.indexer.index(),
					getNoteText: this.getNoteText,
					score: (query, passages, signal) => reranker.score(query, passages, signal),
					device: () => {
						const status = reranker.status();
						return status.kind === "ready" ? status.device : null;
					},
					config: RERANKER_MODEL,
				}),
			};
		} else {
			this.reranking = null;
		}

		this.isIndexEmpty = async () => this.indexer.index()?.isEmpty() ?? true;

		this.similarNotesFeed = makeSimilarNotesFeed({
			statusHub: this.statusHub,
			getSimilarNotesForNote: this.getSimilarNotesForNote,
			isIndexEmpty: this.isIndexEmpty,
			isIgnoredPath: this.isIgnoredPath,
			synchronizeIndex: () => this.indexer.syncAll(),
			retryModelLoad: () => this.engine.retry(),
		});

		this.similarSearchFeed = makeSimilarSearchFeed({
			statusHub: this.statusHub,
			getSimilarNotesForNote: this.getSimilarNotesForNote,
			getSimilarNotesForText: this.getSimilarNotesForText,
			prepareKeywordSearch: () => this.keywordSearch.prepare(),
			isIndexEmpty: this.isIndexEmpty,
			isIgnoredPath: this.isIgnoredPath,
		});

		this.updateSettings = makeUpdateSettings({
			settingsRepo: this.settingsRepo,
			resync: () => this.indexer.syncAll(),
		});

		this.insertWikilinkAtCursor = makeInsertWikilinkAtCursor({vault: this.vault});

		this.setModelDisabled = makeSetModelDisabled({
			deviceSettingsRepo: this.deviceSettingsRepo,
			engine: this.engine,
		});
	}

	collectEnvironment(): EnvironmentInfo {
		const engine = this.engine.status();
		const {maxRawMarkdownChars} = this.settingsRepo.get();
		return {
			...collectDeviceInfo(this.plugin),
			engineState: engine.kind,
			modelId: "modelId" in engine ? engine.modelId : undefined,
			device: engine.kind === "ready" ? engine.device : undefined,
			indexedNotes: this.indexer.index()?.stats().notes ?? 0,
			maxRawMarkdownChars,
		};
	}

	async shutdown(): Promise<void> {
		this.engine.dispose();
		this.reranking?.reranker.dispose();
		await this.indexer.dispose();
		this.similarNotesFeed.dispose();
		this.statusHub.dispose();
		await this.registry.close().catch((error) => {
			console.error("[Similarity] Failed to flush index on shutdown:", error);
		});
		this.status.clear();
	}
}

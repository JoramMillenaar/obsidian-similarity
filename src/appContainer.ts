import { Plugin } from "obsidian";
import { SearchMode } from "./types";
import { ObsidianStatusBar } from "./obsidian/obsidianStatusBar";
import { ObsidianVault } from "./obsidian/obsidianVault";
import { BinaryEmbeddingFileStore } from "./obsidian/binaryEmbeddingFileStore";
import { ObsidianModelIndexMetaStore } from "./obsidian/obsidianModelIndexMetaStore";
import { LegacyEmbeddingFileStore } from "./obsidian/legacyEmbeddingFileStore";
import { ObsidianPluginDataStore } from "./obsidian/obsidianPluginDataStore";
import { ObsidianSettingsRepository } from "./obsidian/obsidianSettings";
import { loadEmbeddingProvider } from "./embedding/host/workerProvider";
import {
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
import { InsertWikilinkAtCursorUseCase, makeInsertWikilinkAtCursor } from "./app/insertWikilinkAtCursor";
import { IsIgnoredPath, makeIsIgnoredPath } from "./app/isIgnoredPath";
import { GetNoteTextUseCase, makeGetNoteText } from "./app/getNoteText";
import { makeUpdateSettings, UpdateSettingsUseCase } from "./app/updateSettings";
import { makeRunLegacyMigrations, RunLegacyMigrationsUseCase } from "./app/legacyMigrations";

const INDEX_WRITE_THROTTLE_MS = 1000;

export class AppContainer {
	readonly status: StatusReporter;
	readonly vault: Vault;
	readonly pluginDataStore: ObsidianPluginDataStore;
	readonly modelIndexMetaStore: ModelIndexMetaStore;
	readonly embeddingFileStore: EmbeddingFileStore;
	readonly legacyEmbeddingFileStore: LegacyEmbeddingFileStore;
	readonly settingsRepo: SettingsRepository;

	readonly engine: EmbeddingEngine;
	readonly indexer: Indexer;
	readonly statusHub: StatusHub;

	readonly similarNotesFeed: SimilarNotesFeed;
	readonly similarSearchFeed: SimilarSearchFeed;
	readonly insertWikilinkAtCursor: InsertWikilinkAtCursorUseCase;
	readonly updateSettings: UpdateSettingsUseCase;
	readonly setSearchMode: (mode: SearchMode) => Promise<void>;
	readonly runLegacyMigrations: RunLegacyMigrationsUseCase;

	readonly getNoteText: GetNoteTextUseCase;
	readonly isIgnoredPath: IsIgnoredPath;
	readonly getSimilarNotesForNote: GetSimilarNotesForNoteUseCase;
	readonly getSimilarNotesForText: GetSimilarNotesForTextUseCase;
	readonly isIndexEmpty: () => Promise<boolean>;

	private readonly registry: IndexRegistry;

	constructor(plugin: Plugin) {
		this.status = new ObsidianStatusBar(plugin);
		this.vault = new ObsidianVault(plugin);
		this.pluginDataStore = new ObsidianPluginDataStore(plugin);
		this.modelIndexMetaStore = new ObsidianModelIndexMetaStore(plugin);
		this.embeddingFileStore = new BinaryEmbeddingFileStore(plugin);
		this.legacyEmbeddingFileStore = new LegacyEmbeddingFileStore(plugin);
		this.settingsRepo = new ObsidianSettingsRepository(this.pluginDataStore);

		this.registry = new IndexRegistry(
			{metaStore: this.modelIndexMetaStore, binaryStore: this.embeddingFileStore},
			{throttleMs: INDEX_WRITE_THROTTLE_MS},
		);

		this.runLegacyMigrations = makeRunLegacyMigrations({
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
			loadEmbedder: loadEmbeddingProvider,
			settingsRepo: this.settingsRepo,
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
			if (!index) return [];
			return makeGetSimilarNotesForNote({index})({mode: this.settingsRepo.get().searchMode, ...args});
		};

		this.getSimilarNotesForText = async (args) => {
			const index = this.indexer.index();
			if (!index) return [];
			return makeGetSimilarNotesForText({
				index,
				embed: (text) => this.engine.embed(text, {priority: "high"}),
			})({mode: this.settingsRepo.get().searchMode, ...args});
		};

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
			isIndexEmpty: this.isIndexEmpty,
			isIgnoredPath: this.isIgnoredPath,
		});

		this.updateSettings = makeUpdateSettings({
			settingsRepo: this.settingsRepo,
			engine: this.engine,
			resync: () => this.indexer.syncAll(),
		});

		this.insertWikilinkAtCursor = makeInsertWikilinkAtCursor({vault: this.vault});

		this.setSearchMode = async (mode) => {
			await this.settingsRepo.updatePartial({searchMode: mode});
			this.similarNotesFeed.refresh();
		};
	}

	async shutdown(): Promise<void> {
		this.engine.dispose();
		await this.indexer.dispose();
		this.similarNotesFeed.dispose();
		this.statusHub.dispose();
		await this.registry.close().catch((error) => {
			console.error("[Similarity] Failed to flush index on shutdown:", error);
		});
		this.status.clear();
	}
}

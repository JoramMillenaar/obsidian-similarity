import { EmbeddingModelConfig, EmbeddingModelId } from "../types";
import {
	EmbeddingPort,
	IndexRepository,
	IndexStorage,
	ModelLoadProgress,
	NoteSource,
	SettingsRepository
} from "../ports";
import { loadEmbeddingProvider } from "../infra/embedder/embeddingProvider";
import { MonolithicIndexRepository } from "../infra/index/monolithicIndexRepository";
import { KeyedDebouncer } from "../domain/debouncer";
import { EmbedTextUseCase, makeEmbedText } from "./embedText";
import { IndexNoteUseCase, makeIndexNote } from "./indexNote";
import { GetSimilarNotesForNoteUseCase, makeGetSimilarNotesForNote } from "./getSimilarNotesForNote";
import { GetSimilarNotesForTextUseCase, makeGetSimilarNotesForText } from "./getSimilarNotesForText";
import { GetNoteTextUseCase } from "./getNoteText";
import { IsIgnoredPath } from "./isIgnoredPath";
import { BuildIndexSyncPlanUseCase, makeBuildIndexSyncPlan } from "./buildIndexSyncPlan";
import { makeSynchronizeIndex, SynchronizeIndexUseCase } from "./synchronizeIndex";
import { LiveNoteSync, makeLiveNoteSync } from "./liveNoteSync";
import { IndexingWorker, Priority } from "./indexingWorker";

export type Generation = {
	readonly modelId: EmbeddingModelId;
	readonly embedder: EmbeddingPort;
	readonly indexRepo: IndexRepository;
	readonly indexNote: IndexNoteUseCase;
	readonly embedText: EmbedTextUseCase;
	readonly getSimilarNotesForNote: GetSimilarNotesForNoteUseCase;
	readonly getSimilarNotesForText: GetSimilarNotesForTextUseCase;
	readonly buildIndexSyncPlan: BuildIndexSyncPlanUseCase;
	readonly synchronizeIndex: SynchronizeIndexUseCase;
	readonly liveNoteSync: LiveNoteSync;
	unload(): void;
};

export type GenerationSharedDeps = {
	indexStorage: IndexStorage;
	noteSource: NoteSource;
	getNoteText: GetNoteTextUseCase;
	isIgnoredPath: IsIgnoredPath;
	settingsRepo: SettingsRepository;
	worker: IndexingWorker;
	upsertDebouncer: KeyedDebouncer<string>;
	onNoteUpdated: (noteId: string) => void;
};

export type BuildGenerationUseCase = (
	modelId: EmbeddingModelId,
	config: EmbeddingModelConfig,
	onProgress?: (progress: ModelLoadProgress) => void,
	signal?: AbortSignal,
) => Promise<Generation>;

export function makeBuildGeneration(deps: GenerationSharedDeps): BuildGenerationUseCase {
	return async function buildGeneration(modelId, config, onProgress, signal) {
		const embedderPromise = loadEmbeddingProvider(config, onProgress, signal);
		const repairPromise = deps.indexStorage.repair(modelId);

		let embedder: EmbeddingPort;
		try {
			[embedder] = await Promise.all([embedderPromise, repairPromise]);
		} catch (error) {
			await embedderPromise.then((loaded) => loaded.unload()).catch(() => undefined);
			throw error;
		}

		const indexRepo = new MonolithicIndexRepository(deps.indexStorage, modelId);

		const embedText = makeEmbedText({embedder, settingsRepo: deps.settingsRepo});
		const embedQuery: EmbedTextUseCase = (text, maxChunkSize) =>
			deps.worker.submitEmbed(() => embedText(text, maxChunkSize));

		const indexNote = makeIndexNote({
			getNoteText: deps.getNoteText,
			indexRepo,
			isIgnoredPath: deps.isIgnoredPath,
			embedText,
		});

		const getSimilarNotesForNote = makeGetSimilarNotesForNote({indexRepo});
		const getSimilarNotesForText = makeGetSimilarNotesForText({indexRepo, embedText: embedQuery});

		const buildIndexSyncPlan = makeBuildIndexSyncPlan({
			noteSource: deps.noteSource,
			indexRepo,
			settingsRepo: deps.settingsRepo,
		});

		const synchronizeIndex = makeSynchronizeIndex({
			indexRepo,
			buildIndexSyncPlan,
			worker: deps.worker,
		});

		const liveNoteSync = makeLiveNoteSync({
			indexRepo,
			requestIndex: (noteId: string, priority: Priority) => deps.worker.submitNote(noteId, priority),
			promoteIndex: (noteId: string, priority: Priority) => deps.worker.promote(noteId, priority),
			updateDebouncer: deps.upsertDebouncer,
			onNoteUpdated: deps.onNoteUpdated,
		});

		return {
			modelId,
			embedder,
			indexRepo,
			indexNote,
			embedText,
			getSimilarNotesForNote,
			getSimilarNotesForText,
			buildIndexSyncPlan,
			synchronizeIndex,
			liveNoteSync,
			unload: () => embedder.unload(),
		};
	};
}

/**
 * DEV-ONLY note pipeline inspection.
 *
 * Reruns the real pipeline for a single note using the exact same
 * dependencies as production — `getNoteText` for the extracted/prepared text
 * and the real `EmbeddingPort.embed` for chunking — so nothing here can drift
 * from what indexing does. Chunk `start`/`end` therefore index into
 * `preparedText` exactly as they do in production.
 *
 * Reached only through the `__DEV__` guard in `main.ts`, so esbuild tree-shakes
 * it (and the modal it feeds) out of production builds.
 */
import { RawNote, SimilaritySettings } from "../types";
import { EmbeddedChunk, EmbeddingPort, NoteSource, SettingsRepository } from "../ports";
import { GetNoteTextUseCase } from "../app/getNoteText";

export type NotePipelineInspection = {
	note: RawNote;
	settings: SimilaritySettings;
	/** Untruncated markdown as read from the note. */
	rawMarkdown: string;
	/** The exact string handed to the embedder, produced by `getNoteText`. */
	preparedText: string;
	/** Chunk spans (and vectors) from the real embedder; offsets index into `preparedText`. */
	chunks: EmbeddedChunk[];
};

export type InspectNotePipelineDeps = {
	noteSource: NoteSource;
	getNoteText: GetNoteTextUseCase;
	settingsRepo: SettingsRepository;
	embedder: EmbeddingPort;
};

export async function inspectNotePipeline(
	deps: InspectNotePipelineDeps,
	noteId: string,
): Promise<NotePipelineInspection | null> {
	const note = await deps.noteSource.getNoteById(noteId);
	if (!note) return null;

	const settings = await deps.settingsRepo.get();
	const preparedText = await deps.getNoteText(noteId);

	// Run the real embedder so the reported spans are the ones production would
	// store. Vectors are computed and discarded here — only start/end matter.
	const chunks = preparedText
		? (await deps.embedder.embed(preparedText, { maxOverlapPercent: settings.maxOverlapPercent })) ?? []
		: [];

	return {
		note,
		settings,
		rawMarkdown: note.markdown,
		preparedText,
		chunks,
	};
}

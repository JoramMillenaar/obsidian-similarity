/**
 * DEV-ONLY note pipeline inspection.
 *
 * Reruns the real MD→text→chunk pipeline for a single note and returns every
 * intermediate stage, so the inspector modal can show what the embedder
 * actually sees. It reuses the production building blocks — `truncateText`,
 * `prepareExtractedNoteForEmbedding`, the live `MarkdownTextExtractor`, and the
 * real `EmbeddingPort.embed` — so nothing here can drift from what indexing
 * does. Chunk `start`/`end` therefore index into `preparedText` exactly as they
 * do in production.
 *
 * Reached only through the `__DEV__` guard in `main.ts`, so esbuild tree-shakes
 * it (and the modal it feeds) out of production builds.
 */
import { prepareExtractedNoteForEmbedding, truncateText } from "../domain/indexing";
import { IndexingWarning, PrepareNoteResult, RawNote, SimilaritySettings } from "../types";
import { EmbeddedChunk, EmbeddingPort, MarkdownTextExtractor, NoteSource, SettingsRepository } from "../ports";

export type NotePipelineInspection = {
	note: RawNote;
	settings: SimilaritySettings;
	/** Untruncated markdown as read from the note. */
	rawMarkdown: string;
	/** Markdown after the `maxRawMarkdownChars` cap that feeds extraction. */
	boundedMarkdown: string;
	rawMarkdownTruncated: boolean;
	/** MD→semantic text: the extractor's rendered `textContent`. */
	extractedText: string;
	/** Full result of preparation (normalize → title-weight → truncate). */
	prepare: PrepareNoteResult;
	/** The exact string handed to the embedder, or null when preparation rejects. */
	preparedText: string | null;
	/** Chunk spans (and vectors) from the real embedder; offsets index into `preparedText`. */
	chunks: EmbeddedChunk[];
};

export type InspectNotePipelineDeps = {
	noteSource: NoteSource;
	markdownTextExtractor: MarkdownTextExtractor;
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
	const warnings: IndexingWarning[] = [];

	// Mirror prepareNoteForEmbedding exactly, but keep every intermediate.
	const boundedMarkdown = truncateText(
		note.markdown,
		settings.maxRawMarkdownChars,
		"raw-markdown-truncated",
		warnings,
	);
	const extractedText = await deps.markdownTextExtractor.extract(boundedMarkdown);
	const prepare = prepareExtractedNoteForEmbedding({
		noteId: note.id,
		title: note.title,
		extractedText,
		settings,
		warnings,
	});

	const preparedText = prepare.status === "ready" ? prepare.value.preparedText : null;

	// Run the real embedder so the reported spans are the ones production would
	// store. Vectors are computed and discarded here — only start/end matter.
	const chunks = preparedText
		? (await deps.embedder.embed(preparedText, { maxOverlapPercent: settings.maxOverlapPercent })) ?? []
		: [];

	return {
		note,
		settings,
		rawMarkdown: note.markdown,
		boundedMarkdown,
		rawMarkdownTruncated: note.markdown.length > boundedMarkdown.length,
		extractedText,
		prepare,
		preparedText,
		chunks,
	};
}

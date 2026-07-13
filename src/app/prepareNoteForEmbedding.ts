import { prepareExtractedNoteForEmbedding, truncateText } from "../domain/indexing";
import { IndexingWarning, PrepareNoteResult } from "../types";
import { MarkdownTextExtractor, NoteSource, SettingsRepository } from "../ports";

export type PrepareNoteForEmbeddingUseCase = (noteId: string) => Promise<PrepareNoteResult>;

export function makePrepareNoteForEmbedding(deps: {
	noteSource: NoteSource;
	markdownTextExtractor: MarkdownTextExtractor;
	settingsRepo: SettingsRepository;
}): PrepareNoteForEmbeddingUseCase {
	return async function prepareNoteForEmbedding(noteId: string): Promise<PrepareNoteResult> {
		const note = await deps.noteSource.getNoteById(noteId);
		if (!note) {
			return {
				status: "reject",
				reason: "missing-note",
				warnings: [],
			};
		}

		const settings = await deps.settingsRepo.get();
		const warnings: IndexingWarning[] = [];
		const boundedMarkdown = truncateText(
			note.markdown,
			settings.maxRawMarkdownChars,
			"raw-markdown-truncated",
			warnings,
		);
		const extractedText = await deps.markdownTextExtractor.extract(boundedMarkdown);

		return prepareExtractedNoteForEmbedding({
			noteId: note.id,
			extractedText,
			settings,
			warnings,
		});
	};
}

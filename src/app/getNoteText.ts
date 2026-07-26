import { MarkdownTextExtractor, NoteSource, SettingsRepository } from "../ports";

export type GetNoteTextUseCase = (noteId: string) => Promise<string>;

export function makeGetNoteText(deps: {
  noteSource: NoteSource;
  markdownTextExtractor: MarkdownTextExtractor;
  settingsRepo: SettingsRepository;
}): GetNoteTextUseCase {
  return async function getNoteText(noteId: string): Promise<string> {
    const note = await deps.noteSource.getNoteById(noteId);
    if (!note) throw new Error(`Could not find note with noteId '${noteId}`);

    const settings = await deps.settingsRepo.get();
    const boundedMarkdown = note.markdown.slice(0, settings.maxRawMarkdownChars);
    const extractedText = await deps.markdownTextExtractor.extract(boundedMarkdown);
	const fullText = `${note.title}\n${extractedText}`;
    return fullText.slice(0, settings.maxExtractedChars);
  };
}

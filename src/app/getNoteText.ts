import { SettingsRepository, Vault } from "../ports";

export type NoteText = {
	text: string;
	/** Whether the note's markdown or extracted text was longer than the configured character caps. */
	truncated: boolean;
};

export type GetNoteTextUseCase = (noteId: string) => Promise<NoteText>;

export function makeGetNoteText(deps: {
	vault: Vault;
	settingsRepo: SettingsRepository;
}): GetNoteTextUseCase {
	return async function getNoteText(noteId: string): Promise<NoteText> {
		const note = await deps.vault.getNote(noteId);
		if (!note) throw new Error(`Could not find note with noteId '${noteId}'`);

		const settings = deps.settingsRepo.get();
		const truncatedRaw = note.markdown.length > settings.maxRawMarkdownChars;
		const boundedMarkdown = note.markdown.slice(0, settings.maxRawMarkdownChars);
		const extractedText = await deps.vault.extractText(boundedMarkdown);
		const fullText = `${note.title}\n${extractedText}`;
		const truncatedExtracted = fullText.length > settings.maxExtractedChars;
		return {
			text: fullText.slice(0, settings.maxExtractedChars),
			truncated: truncatedRaw || truncatedExtracted,
		};
	};
}

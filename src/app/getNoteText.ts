import { SettingsRepository, Vault } from "../ports";

export type NoteText = {
	text: string;
	/** Whether the note's markdown was longer than the configured character cap. */
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

		const {maxRawMarkdownChars} = deps.settingsRepo.get();
		const extractedText = await deps.vault.extractText(note.markdown.slice(0, maxRawMarkdownChars));
		return {
			text: `${note.title}\n${extractedText}`,
			truncated: note.markdown.length > maxRawMarkdownChars,
		};
	};
}

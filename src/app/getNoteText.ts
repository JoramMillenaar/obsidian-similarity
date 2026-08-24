import { SettingsRepository, Vault } from "../ports";

export type GetNoteTextUseCase = (noteId: string) => Promise<string>;

export function makeGetNoteText(deps: {
	vault: Vault;
	settingsRepo: SettingsRepository;
}): GetNoteTextUseCase {
	return async function getNoteText(noteId: string): Promise<string> {
		const note = await deps.vault.getNote(noteId);
		if (!note) throw new Error(`Could not find note with noteId '${noteId}'`);

		const settings = deps.settingsRepo.get();
		const boundedMarkdown = note.markdown.slice(0, settings.maxRawMarkdownChars);
		const extractedText = await deps.vault.extractText(boundedMarkdown);
		const fullText = `${note.title}\n${extractedText}`;
		return fullText.slice(0, settings.maxExtractedChars);
	};
}

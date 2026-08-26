import { NoteIndexCandidate, RawNote } from "../types";

export type ActivateOptions = {
	reveal?: boolean;
	focus?: boolean;
};

export interface Vault {
	getNote(noteId: string): Promise<RawNote | null>;

	listNoteIds(): string[];

	listIndexCandidates(): NoteIndexCandidate[];

	extractText(markdown: string, sourcePath?: string): Promise<string>;

	insertTextAtCursor(text: string): boolean;

	activateSimilarityView(options?: ActivateOptions): Promise<void>;
}

import { formatWikilink } from "../core/text/wikilink";
import { Vault } from "../ports";

export type InsertWikilinkAtCursorResult = "inserted" | "no-editor";

export type InsertWikilinkAtCursorUseCase = (noteId: string) => InsertWikilinkAtCursorResult;

export function makeInsertWikilinkAtCursor(deps: {
	vault: Vault;
}): InsertWikilinkAtCursorUseCase {
	return function insertWikilinkAtCursor(noteId: string): InsertWikilinkAtCursorResult {
		const inserted = deps.vault.insertTextAtCursor(
			formatWikilink(noteId, deps.vault.listNoteIds()),
		);
		return inserted ? "inserted" : "no-editor";
	};
}

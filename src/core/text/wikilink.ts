export function stripMarkdownExtension(noteId: string): string {
  return noteId.replace(/\.md$/i, "");
}

export function getBasename(noteId: string): string {
  return stripMarkdownExtension(noteId).split("/").pop() ?? stripMarkdownExtension(noteId);
}

export function getWikilinkTarget(noteId: string, allNoteIds: string[]): string {
  const basename = getBasename(noteId);
  const duplicateCount = allNoteIds.filter((id) => getBasename(id) === basename).length;
  return duplicateCount > 1 ? stripMarkdownExtension(noteId) : basename;
}

export function formatWikilink(noteId: string, allNoteIds: string[]): string {
  return `[[${getWikilinkTarget(noteId, allNoteIds)}]]`;
}

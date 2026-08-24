import { RelatedNote } from "../types";
import { GetSimilarNotesForNoteUseCase } from "./getSimilarNotesForNote";
import { IsIgnoredPath } from "../app/isIgnoredPath";
import { isMarkdownPath } from "../core/rules/markdownPath";
import { backendNoticeFor, engineNoticeFor, SimilarNotesNotice } from "../status/notices";
import { StatusHub } from "../status/statusHub";

export type ResolveSimilarNotesResult = {
	items: RelatedNote[];
	notice?: SimilarNotesNotice;
	indexEmpty?: boolean;
};

export type ResolveSimilarNotesDeps = {
	statusHub: StatusHub;
	getSimilarNotesForNote: GetSimilarNotesForNoteUseCase;
	isIndexEmpty: () => Promise<boolean>;
	isIgnoredPath: IsIgnoredPath;
};

export async function resolveSimilarNotesForNote(
	deps: ResolveSimilarNotesDeps,
	noteId: string | null,
): Promise<ResolveSimilarNotesResult> {
	if (noteId === null) {
		return {items: [], notice: {kind: "no-active-note"}};
	}
	if (!isMarkdownPath(noteId)) {
		return {items: [], notice: {kind: "unsupported-file"}};
	}
	if (deps.isIgnoredPath(noteId)) {
		return {items: [], notice: {kind: "ignored-path"}};
	}

	// Ranking stored vectors needs no model, so results are fetched before the
	// engine state is consulted: a downloading or failed model still shows results.
	const items = await deps.getSimilarNotesForNote({noteId}).catch(() => []);

	const engineNotice = engineNoticeFor(deps.statusHub.getEngineState());
	if (engineNotice) return {items, notice: engineNotice};

	const indexEmpty = await deps.isIndexEmpty().catch(() => false);
	return {items, notice: backendNoticeFor(indexEmpty, deps.statusHub.getIndexingState()), indexEmpty};
}

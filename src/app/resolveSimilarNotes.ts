import { RelatedNote } from "../types";
import { GetSimilarNotesForNoteUseCase } from "./getSimilarNotesForNote";
import { IsIgnoredPath } from "./isIgnoredPath";
import { isMarkdownPath } from "../domain/markdownPath";
import { backendNoticeFor, SimilarNotesNotice } from "./similarNotesNotice";
import { BackendState } from "./backendState";

export type ResolveSimilarNotesResult = {
	items: RelatedNote[];
	notice?: SimilarNotesNotice;
	indexEmpty?: boolean;
};

export type ResolveSimilarNotesDeps = {
	backendState: BackendState;
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
	if (await deps.isIgnoredPath(noteId)) {
		return {items: [], notice: {kind: "ignored-path"}};
	}

	const backend = deps.backendState;
	const modelState = backend.getModelState();
	const ready = modelState.status === "ready";

	const items = await deps.getSimilarNotesForNote({noteId}).catch(() => []);

	if (!ready) {
		return {
			items,
			notice: {kind: "warming-up", progress: modelState.status === "loading" ? (modelState.progress?.progress ?? null) : null},
		};
	}

	const indexEmpty = await deps.isIndexEmpty().catch(() => false);
	return {items, notice: backendNoticeFor(indexEmpty, backend.getIndexingState()), indexEmpty};
}

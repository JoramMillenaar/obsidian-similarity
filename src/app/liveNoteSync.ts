import { isMarkdownPath } from "../domain/markdownPath";
import { KeyedDebouncer } from "../domain/debouncer";
import { IndexRepository } from "../ports";
import { IsIgnoredPath } from "./isIgnoredPath";
import { BumpIndexPriorityUseCase, HasPendingIndexUseCase, RequestIndexUseCase } from "./indexSyncWorker";


export type LiveNoteSync = {
	view(noteId: string): void;
	update(noteId: string): void;
	delete(noteId: string): Promise<void>;
	rename(oldId: string, newId: string): Promise<void>;
};

export type LiveNoteSyncDeps = {
	indexRepo: IndexRepository;
	isIgnoredPath: IsIgnoredPath;
	bumpPriority: BumpIndexPriorityUseCase;
	requestIndex: RequestIndexUseCase;
	hasPendingIndex: HasPendingIndexUseCase;
	updateDebouncer: KeyedDebouncer<string>;
};

export function makeLiveNoteSync(deps: LiveNoteSyncDeps): LiveNoteSync {
	return {
		view(noteId) {
			deps.bumpPriority(noteId);
		},

		update(noteId) {
			if (!isMarkdownPath(noteId)) return;

			if (deps.hasPendingIndex(noteId)) {
				deps.bumpPriority(noteId);
				return;
			}

			deps.updateDebouncer.schedule(noteId, async () => {
				if (await deps.isIgnoredPath(noteId)) return;
				deps.requestIndex(noteId);
			});
		},

		async delete(noteId) {
			try {
				await deps.indexRepo.remove(noteId);
			} catch (error) {
				console.error("[Similarity] Delete from index failed", error);
			}
		},

		async rename(oldId, newId) {
			try {
				await deps.indexRepo.rename(oldId, newId);
			} catch (error) {
				console.error("[Similarity] Rename note failed", error);
			}
		},
	};
}

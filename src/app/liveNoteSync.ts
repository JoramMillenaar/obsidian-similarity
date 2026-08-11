import { KeyedDebouncer } from "../domain/debouncer";
import { Priority } from "../domain/priorityQueue";
import { IndexRepository } from "../ports";
import { IndexTaskOutcome } from "./indexingWorker";


export type LiveNoteSync = {
	view(noteId: string): void;
	update(noteId: string): void;
	delete(noteId: string): Promise<void>;
	rename(oldId: string, newId: string): Promise<void>;
};

export type LiveNoteSyncDeps = {
	indexRepo: IndexRepository;
	requestIndex: (noteId: string, priority: Priority) => Promise<IndexTaskOutcome>;
	updateDebouncer: KeyedDebouncer<string>;
	onNoteUpdated?: (noteId: string) => void;
};

export function makeLiveNoteSync(deps: LiveNoteSyncDeps): LiveNoteSync {
	return {
		view(noteId) {
			// TODO: too expensive, just check whether it's in pending to be indexed, if so, bump it up.
			void deps.requestIndex(noteId, "medium").catch((error) => {
				console.error("[Similarity] Indexing viewed note failed", error);
			});
		},

		update(noteId) {
			deps.updateDebouncer.schedule(noteId, async () => {
				try {
					await deps.requestIndex(noteId, "medium");
				} catch (error) {
					console.error("[Similarity] Indexing edited note failed", error);
					return;
				}
				deps.onNoteUpdated?.(noteId);
			});
		},

		async delete(noteId) {
			try {
				await deps.indexRepo.remove(noteId);
				deps.onNoteUpdated?.(noteId);
			} catch (error) {
				console.error("[Similarity] Delete from index failed", error);
			}
		},

		async rename(oldId, newId) {
			try {
				await deps.indexRepo.rename(oldId, newId);
				deps.onNoteUpdated?.(oldId);
			} catch (error) {
				console.error("[Similarity] Rename note failed", error);
			}
		},
	};
}

import { KeyedDebouncer } from "../domain/debouncer";
import { IndexRepository } from "../ports";
import { IndexNoteUseCase } from "./indexNote";


export type LiveNoteSync = {
	view(noteId: string): void;
	update(noteId: string): void;
	delete(noteId: string): Promise<void>;
	rename(oldId: string, newId: string): Promise<void>;
};

export type LiveNoteSyncDeps = {
	indexRepo: IndexRepository;
	indexNote: IndexNoteUseCase;
	updateDebouncer: KeyedDebouncer<string>;
};

export function makeLiveNoteSync(deps: LiveNoteSyncDeps): LiveNoteSync {
	return {
		view(noteId) {
			// TODO: too expensive just do a queue check instead if you can.
			void deps.indexNote(noteId, "medium");
		},

		update(noteId) {
			deps.updateDebouncer.schedule(noteId, async () => {
				await deps.indexNote(noteId, "medium");
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

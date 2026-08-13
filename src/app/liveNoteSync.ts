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
	promoteIndex: (noteId: string, priority: Priority) => Promise<IndexTaskOutcome> | null;
	updateDebouncer: KeyedDebouncer<string>;
	onNoteUpdated?: (noteId: string) => void;
};

export function makeLiveNoteSync(deps: LiveNoteSyncDeps): LiveNoteSync {
	async function handleView(noteId: string): Promise<void> {
		const promoted = deps.promoteIndex(noteId, "medium");
		if (promoted) {
			await promoted;
			return;
		}

		if (await deps.indexRepo.findById(noteId)) return;
		await deps.requestIndex(noteId, "medium");
	}

	return {
		view(noteId) {
			void handleView(noteId).catch((error) => {
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

import { KeyedDebouncer } from "../domain/debouncer";
import { isUnderFolder, repathToFolder } from "../domain/folderPath";
import { Priority } from "../domain/priorityQueue";
import { IndexRepository } from "../ports";
import { IndexTaskOutcome } from "./indexingWorker";


export type LiveNoteSync = {
	view(noteId: string): void;
	update(noteId: string): void;
	delete(noteId: string): Promise<void>;
	deleteFolder(folderPath: string): Promise<void>;
	rename(oldId: string, newId: string): Promise<void>;
	renameFolder(oldPath: string, newPath: string): Promise<void>;
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

	async function idsUnder(folderPath: string): Promise<string[]> {
		const index = await deps.indexRepo.listAll();
		return index.map((note) => note.id).filter((id) => isUnderFolder(id, folderPath));
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
				deps.updateDebouncer.cancel(noteId);
				await deps.indexRepo.remove(noteId);
				deps.onNoteUpdated?.(noteId);
			} catch (error) {
				console.error("[Similarity] Delete from index failed", error);
			}
		},

		async deleteFolder(folderPath) {
			try {
				const noteIds = await idsUnder(folderPath);
				if (noteIds.length === 0) return;

				for (const noteId of noteIds) deps.updateDebouncer.cancel(noteId);
				await deps.indexRepo.removeMany(noteIds);
				deps.onNoteUpdated?.(folderPath);
			} catch (error) {
				console.error("[Similarity] Deleting a folder from the index failed", error);
			}
		},

		async rename(oldId, newId) {
			try {
				deps.updateDebouncer.cancel(oldId);
				await deps.indexRepo.rename(oldId, newId);
				deps.onNoteUpdated?.(newId);
			} catch (error) {
				console.error("[Similarity] Rename note failed", error);
			}
		},

		async renameFolder(oldPath, newPath) {
			try {
				const renames = (await idsUnder(oldPath)).map((oldId) => ({
					oldId,
					newId: repathToFolder(oldId, oldPath, newPath),
				}));
				if (renames.length === 0) return;

				for (const {oldId} of renames) deps.updateDebouncer.cancel(oldId);
				await deps.indexRepo.renameMany(renames);
				deps.onNoteUpdated?.(newPath);
			} catch (error) {
				console.error("[Similarity] Renaming a folder in the index failed", error);
			}
		},
	};
}

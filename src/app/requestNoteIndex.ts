import { Priority } from "./embedText";
import { IndexNoteUseCase } from "./indexNote";

export type RequestIndexUseCase = (noteId: string, priority?: Priority) => void;

type RequestNoteIndexDeps = {
	progress: {
		track<T>(key: string, run: () => Promise<T>): Promise<T>;
	};
	indexNote: IndexNoteUseCase;
};

export function makeRequestNoteIndex(deps: RequestNoteIndexDeps): RequestIndexUseCase {
	return function requestNoteIndex(noteId, priority) {
		void deps.progress
			.track(noteId, () => deps.indexNote(noteId, priority))
			.catch(() => {
				// The progress tracker already records and reports the failure.
			});
	};
}

import { IndexedNote } from "../types";

export interface IndexRepository {
	findById(noteId: string): Promise<IndexedNote | null>;

	listAll(): Promise<IndexedNote[]>;

	isEmpty(): Promise<boolean>;

	upsert(note: IndexedNote): Promise<void>;

	upsertMany(notes: IndexedNote[]): Promise<void>;

	remove(noteId: string): Promise<void>;

	rename(oldId: string, newId: string): Promise<void>;

	/** Forces any throttled/pending disk write to complete immediately. */
	flush(): Promise<void>;
}

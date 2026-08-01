import { IndexedNote } from "../types";

export interface IndexRepository {
	findById(noteId: string): Promise<IndexedNote | null>;

	listAll(): Promise<IndexedNote[]>;

	isEmpty(): Promise<boolean>;

	upsert(note: IndexedNote): Promise<void>;

	upsertMany(notes: IndexedNote[]): Promise<void>;

	remove(noteId: string): Promise<void>;

	clear(): Promise<void>;

	rename(oldId: string, newId: string): Promise<void>;

	flush(): Promise<void>;
}

import { EmbeddingModelId, IndexedNote } from "../types";

export type IndexRename = { oldId: string; newId: string };

export interface IndexRepository {
	readonly modelId: EmbeddingModelId;

	findById(noteId: string): Promise<IndexedNote | null>;

	listAll(): Promise<IndexedNote[]>;

	isEmpty(): Promise<boolean>;

	upsert(note: IndexedNote): Promise<void>;

	upsertMany(notes: IndexedNote[]): Promise<void>;

	remove(noteId: string): Promise<void>;

	removeMany(noteIds: string[]): Promise<void>;

	clear(): Promise<void>;

	rename(oldId: string, newId: string): Promise<void>;

	renameMany(renames: IndexRename[]): Promise<void>;
}

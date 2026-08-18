import { EmbeddingModelId, IndexedNote } from "../types";

export interface IndexRepository {
	readonly modelId: EmbeddingModelId;

	findById(noteId: string): Promise<IndexedNote | null>;

	listAll(): Promise<IndexedNote[]>;

	isEmpty(): Promise<boolean>;

	upsert(note: IndexedNote): Promise<void>;

	upsertMany(notes: IndexedNote[]): Promise<void>;

	remove(noteId: string): Promise<void>;

	clear(): Promise<void>;

	rename(oldId: string, newId: string): Promise<void>;
}

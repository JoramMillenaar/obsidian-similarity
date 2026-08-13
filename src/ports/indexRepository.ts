import { EmbeddingModelId, IndexedNote } from "../types";

export interface IndexRepository {
	findById(noteId: string): Promise<IndexedNote | null>;

	listAll(): Promise<IndexedNote[]>;

	isEmpty(): Promise<boolean>;

	upsert(note: IndexedNote, embeddingModelId: EmbeddingModelId): Promise<void>;

	upsertMany(notes: IndexedNote[], embeddingModelId: EmbeddingModelId): Promise<void>;

	remove(noteId: string): Promise<void>;

	clear(): Promise<void>;

	rename(oldId: string, newId: string): Promise<void>;
}

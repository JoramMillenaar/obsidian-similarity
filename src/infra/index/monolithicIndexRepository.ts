import { EmbeddingModelId, IndexedNote } from "../../types";
import { IndexRepository, IndexStorage } from "../../ports";
import { ModelSession } from "../../domain/modelSession";

export class MonolithicIndexRepository implements IndexRepository {
	constructor(
		private readonly storage: IndexStorage,
		private readonly modelSession: ModelSession,
	) {
	}

	async findById(noteId: string): Promise<IndexedNote | null> {
		const index = await this.storage.getAll(this.modelSession.current());
		return index.find(n => n.id === noteId) ?? null;
	}

	async upsert(note: IndexedNote, embeddingModelId: EmbeddingModelId) {
		await this.upsertMany([note], embeddingModelId);
	}

	async upsertMany(notes: IndexedNote[], embeddingModelId: EmbeddingModelId) {
		if (notes.length === 0) return;

		// TODO: this should technically be atomic
		const index = await this.storage.getAll(embeddingModelId);

		const map = new Map(index.map(n => [n.id, n]));

		for (const note of notes) {
			map.set(note.id, note);
		}

		await this.storage.rewrite(embeddingModelId, [...map.values()]);
	}

	async listAll(): Promise<IndexedNote[]> {
		return await this.storage.getAll(this.modelSession.current());
	}

	async isEmpty(): Promise<boolean> {
		return await this.storage.isEmpty(this.modelSession.current());
	}

	async remove(noteId: string) {
		const embeddingModelId = this.modelSession.current();
		const index = await this.storage.getAll(embeddingModelId);
		const next = index.filter(n => n.id !== noteId);
		await this.storage.rewrite(embeddingModelId, next);
	}

	async clear() {
		const embeddingModelId = this.modelSession.current();
		await this.storage.rewrite(embeddingModelId, []);
	}

	async rename(oldId: string, newId: string) {
		if (oldId === newId) return;

		const embeddingModelId = this.modelSession.current();
		const index = await this.storage.getAll(embeddingModelId);

		const existing = index.find(n => n.id === oldId);
		if (!existing) return;

		const filtered = index.filter(n => n.id !== oldId && n.id !== newId);

		const renamed: IndexedNote = {
			...existing,
			id: newId,
		};

		await this.storage.rewrite(embeddingModelId, [...filtered, renamed]);
	}
}

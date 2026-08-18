import { EmbeddingModelId, IndexedNote } from "../../types";
import { IndexRepository, IndexStorage } from "../../ports";

export class MonolithicIndexRepository implements IndexRepository {
	constructor(
		private readonly storage: IndexStorage,
		readonly modelId: EmbeddingModelId,
	) {
	}

	async findById(noteId: string): Promise<IndexedNote | null> {
		const index = await this.storage.getAll(this.modelId);
		return index.find(n => n.id === noteId) ?? null;
	}

	async upsert(note: IndexedNote) {
		await this.upsertMany([note]);
	}

	async upsertMany(notes: IndexedNote[]) {
		if (notes.length === 0) return;

		// TODO: this should technically be atomic
		const index = await this.storage.getAll(this.modelId);

		const map = new Map(index.map(n => [n.id, n]));

		for (const note of notes) {
			map.set(note.id, note);
		}

		await this.storage.rewrite(this.modelId, [...map.values()]);
	}

	async listAll(): Promise<IndexedNote[]> {
		return await this.storage.getAll(this.modelId);
	}

	async isEmpty(): Promise<boolean> {
		return await this.storage.isEmpty(this.modelId);
	}

	async remove(noteId: string) {
		const index = await this.storage.getAll(this.modelId);
		const next = index.filter(n => n.id !== noteId);
		await this.storage.rewrite(this.modelId, next);
	}

	async clear() {
		await this.storage.rewrite(this.modelId, []);
	}

	async rename(oldId: string, newId: string) {
		if (oldId === newId) return;

		const index = await this.storage.getAll(this.modelId);

		const existing = index.find(n => n.id === oldId);
		if (!existing) return;

		const filtered = index.filter(n => n.id !== oldId && n.id !== newId);

		const renamed: IndexedNote = {
			...existing,
			id: newId,
		};

		await this.storage.rewrite(this.modelId, [...filtered, renamed]);
	}
}

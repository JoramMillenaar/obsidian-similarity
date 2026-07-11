import { IndexedNote } from "../../types";
import { IndexRepository, IndexStorage } from "../../ports";

export class JsonIndexedNoteRepository implements IndexRepository {
	constructor(
		private readonly storage: IndexStorage,
	) {
	}

	async findById(noteId: string): Promise<IndexedNote | null> {
		const index = await this.storage.getAll();
		return index.find(n => n.id === noteId) ?? null;
	}

	async upsert(note: IndexedNote) {
		await this.upsertMany([note]);
	}

	async upsertMany(notes: IndexedNote[]) {
		if (notes.length === 0) return;

		const index = await this.storage.getAll();

		const map = new Map(index.map(n => [n.id, n]));

		for (const note of notes) {
			map.set(note.id, note);
		}

		await this.storage.rewrite([...map.values()]);
	}

	async listAll(): Promise<IndexedNote[]> {
		return await this.storage.getAll();
	}

	async isEmpty(): Promise<boolean> {
		return await this.storage.isEmpty();
	}

	async remove(noteId: string) {
		const index = await this.storage.getAll();
		const next = index.filter(n => n.id !== noteId);
		await this.storage.rewrite(next);
	}

	async rename(oldId: string, newId: string) {
		if (oldId === newId) return;

		const index = await this.storage.getAll();

		const existing = index.find(n => n.id === oldId);
		if (!existing) return;

		const filtered = index.filter(n => n.id !== oldId && n.id !== newId);

		const renamed: IndexedNote = {
			...existing,
			id: newId,
		};

		await this.storage.rewrite([...filtered, renamed]);
	}

	async flush(): Promise<void> {
		await this.storage.flush();
	}
}

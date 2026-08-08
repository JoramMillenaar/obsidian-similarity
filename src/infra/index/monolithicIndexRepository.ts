import { IndexedNote } from "../../types";
import { IndexRepository, IndexStorage, SettingsRepository } from "../../ports";

export class MonolithicIndexRepository implements IndexRepository {
	constructor(
		private readonly storage: IndexStorage,
		private readonly settingsRepo: SettingsRepository,
	) {
	}

	async findById(noteId: string): Promise<IndexedNote | null> {
		const {embeddingModelId} = await this.settingsRepo.get();
		const index = await this.storage.getAll(embeddingModelId);
		return index.find(n => n.id === noteId) ?? null;
	}

	async upsert(note: IndexedNote) {
		await this.upsertMany([note]);
	}

	async upsertMany(notes: IndexedNote[]) {
		if (notes.length === 0) return;

		const {embeddingModelId} = await this.settingsRepo.get();

		// TODO: this should technically be atomic
		const index = await this.storage.getAll(embeddingModelId);

		const map = new Map(index.map(n => [n.id, n]));

		for (const note of notes) {
			map.set(note.id, note);
		}

		await this.storage.rewrite(embeddingModelId, [...map.values()]);
	}

	async listAll(): Promise<IndexedNote[]> {
		const {embeddingModelId} = await this.settingsRepo.get();
		return await this.storage.getAll(embeddingModelId);
	}

	async isEmpty(): Promise<boolean> {
		const {embeddingModelId} = await this.settingsRepo.get();
		return await this.storage.isEmpty(embeddingModelId);
	}

	async remove(noteId: string) {
		const {embeddingModelId} = await this.settingsRepo.get();
		const index = await this.storage.getAll(embeddingModelId);
		const next = index.filter(n => n.id !== noteId);
		await this.storage.rewrite(embeddingModelId, next);
	}

	async clear() {
		const {embeddingModelId} = await this.settingsRepo.get();
		await this.storage.rewrite(embeddingModelId, []);
	}

	async rename(oldId: string, newId: string) {
		if (oldId === newId) return;

		const {embeddingModelId} = await this.settingsRepo.get();
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

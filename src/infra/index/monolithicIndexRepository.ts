import { EmbeddingModelId, IndexedNote } from "../../types";
import { IndexRename, IndexRepository, IndexStorage } from "../../ports";

export class MonolithicIndexRepository implements IndexRepository {
	private mutations: Promise<void> = Promise.resolve();

	constructor(
		private readonly storage: IndexStorage,
		readonly modelId: EmbeddingModelId,
	) {
	}

	private mutate<T>(run: () => Promise<T>): Promise<T> {
		const result = this.mutations.then(run);
		this.mutations = result.then(() => undefined, () => undefined);
		return result;
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

		await this.mutate(async () => {
			const index = await this.storage.getAll(this.modelId);

			const map = new Map(index.map(n => [n.id, n]));

			for (const note of notes) {
				map.set(note.id, note);
			}

			await this.storage.rewrite(this.modelId, [...map.values()]);
		});
	}

	async listAll(): Promise<IndexedNote[]> {
		return await this.storage.getAll(this.modelId);
	}

	async isEmpty(): Promise<boolean> {
		return await this.storage.isEmpty(this.modelId);
	}

	async remove(noteId: string) {
		await this.removeMany([noteId]);
	}

	async removeMany(noteIds: string[]) {
		if (noteIds.length === 0) return;

		await this.mutate(async () => {
			const doomed = new Set(noteIds);
			const index = await this.storage.getAll(this.modelId);
			const next = index.filter(n => !doomed.has(n.id));
			if (next.length === index.length) return;

			await this.storage.rewrite(this.modelId, next);
		});
	}

	async clear() {
		await this.mutate(() => this.storage.rewrite(this.modelId, []));
	}

	async rename(oldId: string, newId: string) {
		await this.renameMany([{oldId, newId}]);
	}

	async renameMany(renames: IndexRename[]) {
		const effective = renames.filter(({oldId, newId}) => oldId !== newId);
		if (effective.length === 0) return;

		await this.mutate(async () => {
			const index = await this.storage.getAll(this.modelId);
			const byId = new Map(index.map(n => [n.id, n]));

			let changed = false;
			for (const {oldId, newId} of effective) {
				const existing = byId.get(oldId);
				if (!existing) continue;

				byId.delete(oldId);
				byId.set(newId, {...existing, id: newId});
				changed = true;
			}
			if (!changed) return;

			await this.storage.rewrite(this.modelId, [...byId.values()]);
		});
	}
}

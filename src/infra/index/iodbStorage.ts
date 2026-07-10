import type { DataAdapter } from "obsidian";
import { normalizePath } from "obsidian";
import {
	openDatabase,
	type Database,
	type StorageAdapter,
	type CorruptionEvent,
	type JsonObject,
} from "iodb";
import { IndexedNote } from "../../types";
import { IndexStorage } from "../../ports";

/** Bridges Obsidian's vault adapter to iodb's StorageAdapter contract. */
class ObsidianAdapter implements StorageAdapter {
	constructor(
		private readonly vault: DataAdapter,
		private readonly baseDir: string,
	) {}

	private p(path: string) {
		return normalizePath(`${this.baseDir}/${path}`);
	}

	async read(path: string) {
		if (!(await this.vault.exists(this.p(path)))) return null;
		return new Uint8Array(await this.vault.readBinary(this.p(path)));
	}
	async write(path: string, data: Uint8Array) {
		await this.vault.writeBinary(this.p(path), data.buffer as ArrayBuffer);
	}
	async remove(path: string) {
		if (await this.vault.exists(this.p(path))) await this.vault.remove(this.p(path));
	}
	async exists(path: string) {
		return this.vault.exists(this.p(path));
	}
	async list(prefix: string) {
		const { files } = await this.vault.list(normalizePath(this.baseDir));
		return files.filter((f) => f.startsWith(this.p(prefix)));
	}
}

const COLLECTION = "index";
const DOC_ID = "store";

/**
 * Wraps IndexedNote[] to satisfy iodb's JsonObject constraint (top-level
 * documents must be objects, not bare arrays).
 */
interface IndexDoc extends JsonObject {
	notes: IndexedNote[];
}

/**
 * Stores the note index as a single JSON document persisted via iodb, whose
 * dual-slot writer and CRC-checked reads replace the manual binary codec's
 * corruption-handling role. `onCorruption` fires when both slots fail
 * validation and the store had to be rebuilt empty.
 *
 * Note: IndexedNote must be JSON-serializable (no Dates, Maps, undefined
 * fields, etc.) — iodb round-trips through JSON.stringify, not a custom
 * binary layout, so the previous codec's format is no longer load-bearing.
 */
export class IoDbIndexStorage implements IndexStorage {
	private dbPromise: Promise<Database> | null = null;

	constructor(
		private readonly vault: DataAdapter,
		private readonly baseDir: string,
		private readonly dbName = "index",
		private readonly onCorruption?: (event: CorruptionEvent) => void,
	) {}

	private async db(): Promise<Database> {
		if (!this.dbPromise) {
			this.dbPromise = openDatabase({
				adapter: new ObsidianAdapter(this.vault, this.baseDir),
				path: this.dbName,
				onCorruption: this.onCorruption,
			});
		}
		return this.dbPromise;
	}

	async getAll(): Promise<IndexedNote[]> {
		const db = await this.db();
		const doc = db.collection<IndexDoc>(COLLECTION).get(DOC_ID);
		return doc?.notes ?? [];
	}

	async rewrite(index: IndexedNote[]): Promise<void> {
		const db = await this.db();
		const col = db.collection<IndexDoc>(COLLECTION);
		const payload = { notes: index } as unknown as IndexDoc;
		if (col.has(DOC_ID)) {
			await col.update(DOC_ID, payload);
		} else {
			await col.insert(payload, DOC_ID);
		}
	}

	async isEmpty(): Promise<boolean> {
		const db = await this.db();
		const doc = db.collection<IndexDoc>(COLLECTION).get(DOC_ID);
		return !doc || doc.notes.length === 0;
	}

	async close(): Promise<void> {
		if (!this.dbPromise) return;
		const db = await this.dbPromise;
		await db.close();
		this.dbPromise = null;
	}
}

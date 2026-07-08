import { DataAdapter } from "obsidian";
import { IndexedNote } from "../../types";
import { IndexStorage } from "../../ports";
import { decodeIndex, encodeIndex, readIndexCount } from "./binaryIndexCodec";

/**
 * Stores the note index as a single compact binary file inside the vault,
 * written through the Obsidian {@link DataAdapter} (`writeBinary`/`readBinary`).
 * Intended for large vaults where keeping the index in the JSON plugin-data
 * file becomes expensive in memory.
 */
export class BinaryVaultIndexStorage implements IndexStorage {
	constructor(
		private readonly adapter: DataAdapter,
		private readonly filePath: string,
	) {
	}

	async getAll(): Promise<IndexedNote[]> {
		if (!(await this.adapter.exists(this.filePath))) return [];
		const buffer = await this.adapter.readBinary(this.filePath);
		return decodeIndex(buffer);
	}

	async rewrite(index: IndexedNote[]): Promise<void> {
		await this.ensureParentDir();
		await this.adapter.writeBinary(this.filePath, encodeIndex(index));
	}

	async isEmpty(): Promise<boolean> {
		if (!(await this.adapter.exists(this.filePath))) return true;
		const buffer = await this.adapter.readBinary(this.filePath);
		return readIndexCount(buffer) === 0;
	}

	private async ensureParentDir(): Promise<void> {
		const separator = this.filePath.lastIndexOf("/");
		if (separator <= 0) return;
		const dir = this.filePath.slice(0, separator);
		if (!(await this.adapter.exists(dir))) {
			await this.adapter.mkdir(dir);
		}
	}
}

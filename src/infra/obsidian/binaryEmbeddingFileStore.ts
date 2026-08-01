import { normalizePath, Plugin } from "obsidian";
import { EmbeddingFileStore } from "../../ports";

/**
 * Owns the vault mechanics (path, exists/read/write) for the embeddings
 * binary sidecar. The only file that touches `obsidian` for this feature —
 * everything else works in ArrayBuffer/Float32Array terms.
 */
export class BinaryEmbeddingFileStore implements EmbeddingFileStore {
	private readonly dir: string;
	private readonly path: string;

	constructor(private readonly plugin: Plugin) {
		this.dir = normalizePath(plugin.manifest.dir
			?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`
		)
		this.path = normalizePath(`${this.dir}/embeddings.bin`);
	}

	async read(): Promise<ArrayBuffer | null> {
		const adapter = this.plugin.app.vault.adapter;
		const exists = await adapter.exists(this.path);
		if (!exists) return null;
		return await adapter.readBinary(this.path);
	}

	async write(buffer: ArrayBuffer): Promise<void> {
		const adapter = this.plugin.app.vault.adapter;
		if (!(await adapter.exists(this.dir))) {
			await adapter.mkdir(this.dir);
		}
		await adapter.writeBinary(this.path, buffer);
	}
}

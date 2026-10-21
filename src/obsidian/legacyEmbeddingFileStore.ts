import { normalizePath, Plugin } from "obsidian";

/** The single vector file written before indexes were kept per model (English model only). */
export class LegacyEmbeddingFileStore {
	private readonly path: string;

	constructor(private readonly plugin: Plugin) {
		const dir = normalizePath(plugin.manifest.dir
			?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`
		);
		this.path = normalizePath(`${dir}/embeddings.bin`);
	}

	/** Resolves with whether there was anything to delete. */
	async remove(): Promise<boolean> {
		const adapter = this.plugin.app.vault.adapter;
		if (!(await adapter.exists(this.path))) return false;
		await adapter.remove(this.path);
		return true;
	}
}

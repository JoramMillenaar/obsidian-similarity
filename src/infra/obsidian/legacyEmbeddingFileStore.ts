import { normalizePath, Plugin } from "obsidian";

export class LegacyEmbeddingFileStore {
	private readonly path: string;

	constructor(private readonly plugin: Plugin) {
		const dir = normalizePath(plugin.manifest.dir
			?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`
		);
		this.path = normalizePath(`${dir}/embeddings.bin`);
	}

	async read(): Promise<ArrayBuffer | null> {
		const adapter = this.plugin.app.vault.adapter;
		if (!(await adapter.exists(this.path))) return null;
		return await adapter.readBinary(this.path);
	}

	async remove(): Promise<void> {
		const adapter = this.plugin.app.vault.adapter;
		if (await adapter.exists(this.path)) {
			await adapter.remove(this.path);
		}
	}
}

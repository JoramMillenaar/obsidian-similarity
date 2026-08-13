import { normalizePath, Plugin } from "obsidian";
import { EmbeddingFileStore } from "../../ports";
import { EmbeddingModelId } from "../../types";

export class BinaryEmbeddingFileStore implements EmbeddingFileStore {
	private readonly dir: string;

	constructor(private readonly plugin: Plugin) {
		this.dir = normalizePath(plugin.manifest.dir
			?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`
		)
	}

	async read(modelId: EmbeddingModelId): Promise<ArrayBuffer | null> {
		const adapter = this.plugin.app.vault.adapter;
		const path = this.pathFor(modelId);
		const exists = await adapter.exists(path);
		if (!exists) return null;
		return await adapter.readBinary(path);
	}

	async write(modelId: EmbeddingModelId, buffer: ArrayBuffer): Promise<void> {
		const adapter = this.plugin.app.vault.adapter;
		if (!(await adapter.exists(this.dir))) {
			await adapter.mkdir(this.dir);
		}
		await adapter.writeBinary(this.pathFor(modelId), buffer);
	}

	private pathFor(modelId: EmbeddingModelId): string {
		return normalizePath(`${this.dir}/embeddings-${modelId}.bin`);
	}
}

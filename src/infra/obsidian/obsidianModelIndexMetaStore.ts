import { normalizePath, Plugin } from "obsidian";
import { ModelIndexMetaStore } from "../../ports";
import { EmbeddingModelId, ModelIndexFile } from "../../types";
import { normalizeModelIndexFile } from "../../domain/normalize";

export class ObsidianModelIndexMetaStore implements ModelIndexMetaStore {
	private readonly dir: string;

	constructor(private readonly plugin: Plugin) {
		this.dir = normalizePath(plugin.manifest.dir
			?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`
		)
	}

	async read(modelId: EmbeddingModelId): Promise<ModelIndexFile | null> {
		const adapter = this.plugin.app.vault.adapter;
		const path = this.pathFor(modelId);
		if (!(await adapter.exists(path))) return null;

		try {
			const raw = JSON.parse(await adapter.read(path)) as Partial<ModelIndexFile>;
			return normalizeModelIndexFile(raw);
		} catch {
			return null;
		}
	}

	async write(modelId: EmbeddingModelId, data: ModelIndexFile): Promise<void> {
		const adapter = this.plugin.app.vault.adapter;
		if (!(await adapter.exists(this.dir))) {
			await adapter.mkdir(this.dir);
		}
		await adapter.write(this.pathFor(modelId), JSON.stringify(data));
	}

	private pathFor(modelId: EmbeddingModelId): string {
		return normalizePath(`${this.dir}/index-${modelId}.json`);
	}
}

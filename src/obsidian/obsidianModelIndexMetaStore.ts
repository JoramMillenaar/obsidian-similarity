import { normalizePath, Plugin } from "obsidian";
import { ModelIndexMetaStore } from "../ports";
import { DeprecatedModelId, EmbeddingModelId, ModelIndexFile } from "../types";
import { normalizeModelIndexFile } from "../core/rules/schema";

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

		const raw = JSON.parse(await adapter.read(path)) as Partial<ModelIndexFile>;
		return normalizeModelIndexFile(raw);
	}

	async write(modelId: EmbeddingModelId, data: ModelIndexFile): Promise<void> {
		const adapter = this.plugin.app.vault.adapter;
		if (!(await adapter.exists(this.dir))) {
			await adapter.mkdir(this.dir);
		}
		await adapter.write(this.pathFor(modelId), JSON.stringify(data));
	}

	async remove(modelId: DeprecatedModelId): Promise<boolean> {
		const adapter = this.plugin.app.vault.adapter;
		const path = this.pathFor(modelId);
		if (!(await adapter.exists(path))) return false;
		await adapter.remove(path);
		return true;
	}

	private pathFor(modelId: EmbeddingModelId | DeprecatedModelId): string {
		return normalizePath(`${this.dir}/index-${modelId}.json`);
	}
}

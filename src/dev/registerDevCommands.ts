/**
 * DEV-ONLY command registration.
 *
 * Everything here is reached exclusively through an `if (__DEV__)` guard in
 * `main.ts`, so esbuild tree-shakes this module (and the benchmark it imports)
 * out of production builds.
 */
import { normalizePath, Notice, Plugin } from "obsidian";
import { AppContainer } from "../appContainer";
import { runIndexingBenchmark } from "./benchmarkIndexing";
import { runStorageBenchmark } from "./benchmarkStorage";
import { NotePipelineInspectorModal } from "./NotePipelineInspectorModal";
import { isMarkdownPath } from "../domain/markdownPath";

export function registerDevCommands(plugin: Plugin, container: AppContainer): void {
	plugin.addCommand({
		id: "dev-inspect-note-pipeline",
		name: "DEV: Inspect note pipeline (extracted text & chunks)",
		callback: () => {
			const file = plugin.app.workspace.getActiveFile();
			if (!file) {
				new Notice("Open a note to inspect its pipeline");
				return;
			}
			if (!isMarkdownPath(file.path)) {
				new Notice("Only Markdown notes have a pipeline to inspect");
				return;
			}
			new NotePipelineInspectorModal(plugin.app, {
				noteSource: container.noteSource,
				markdownTextExtractor: container.markdownTextExtractor,
				settingsRepo: container.settingsRepo,
				embedder: container.embedder,
			}, file.path).open();
		},
	});

	plugin.addCommand({
		id: "dev-benchmark-indexing",
		name: "DEV: Benchmark indexing performance",
		callback: async () => {
			new Notice("Running indexing benchmark — see the developer console…");
			console.log("[Similarity][dev] Starting indexing benchmark");
			try {
				await runIndexingBenchmark({
					embedder: container.embedder,
					markdownTextExtractor: container.markdownTextExtractor,
				});
				new Notice("Indexing benchmark complete (results in console)");
			} catch (error) {
				console.error("[Similarity][dev] Benchmark failed", error);
				new Notice("Indexing benchmark failed (see console)");
			}
		},
	});

	plugin.addCommand({
		id: "dev-benchmark-storage",
		name: "DEV: Compare index storage (JSON vs binary sidecar)",
		callback: async () => {
			new Notice("Comparing index storage — see the developer console…");
			console.log("[Similarity][dev] Starting storage backend comparison");
			try {
				const pluginDir = plugin.manifest.dir
					?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`;
				await runStorageBenchmark({
					adapter: plugin.app.vault.adapter,
					scratchDir: normalizePath(pluginDir),
				});
				new Notice("Storage comparison complete (results in console)");
			} catch (error) {
				console.error("[Similarity][dev] Storage comparison failed", error);
				new Notice("Storage comparison failed (see console)");
			}
		},
	});
}

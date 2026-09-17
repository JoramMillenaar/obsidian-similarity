import { App, Notice, PluginSettingTab, SettingDefinitionItem } from "obsidian";
import RelatedNotes from "../main";
import { parseIgnoredPaths } from "../core/rules/ignorePaths";
import { EMBEDDING_MODELS, MAX_OVERLAP_PERCENT } from "../constants";
import { EmbeddingModelId, SimilaritySettings } from "../types";
import { SettingsRepository } from "../ports";
import { UpdateSettingsUseCase } from "../app/updateSettings";
import { EngineStateReader, EngineStatus, ModelRequestSupersededError } from "../embedding/engine";

export type SettingsViewDeps = {
	settingsRepo: SettingsRepository,
	updateSettings: UpdateSettingsUseCase,
	engine: EngineStateReader,
}

const EMBEDDING_MODEL_OPTIONS: Record<string, string> = Object.fromEntries(
	Object.values(EMBEDDING_MODELS).map((model) => [model.id, model.label]),
);

type NumericSettingKey = "maxRawMarkdownChars" | "maxExtractedChars" | "maxOverlapPercent";

export class SettingView extends PluginSettingTab {
	private ignoredPathsDraft: string;
	private previousModelStatus: EngineStatus["kind"] = "idle";

	constructor(
		app: App,
		plugin: RelatedNotes,
		private readonly deps: SettingsViewDeps,
	) {
		super(app, plugin);
		this.ignoredPathsDraft = this.deps.settingsRepo.get().ignoredPaths.join("\n");
		this.deps.engine.subscribe((status) => {
			if (this.previousModelStatus !== status.kind) this.update();
			this.previousModelStatus = status.kind;
		});
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: "Language",
				desc: "Determine which language to support. Changing this option may start an optimization process in the background. You can pick a different one before it finishes to switch again.",
				control: {
					type: "dropdown",
					key: "embeddingModelId",
					options: EMBEDDING_MODEL_OPTIONS,
				},
			},
			{
				name: "Ignored paths/folders",
				desc: "One entry per line. Folder paths ignore everything under that folder. Append .md to a filename to ignore a specific note.",
				render: (setting) => {
					setting.addTextArea((text) => {
						text
							.setPlaceholder("Templates\nArchive/2023\nScratch.md")
							.setValue(this.ignoredPathsDraft)
							.onChange((value) => {
								this.ignoredPathsDraft = value;
							});
						text.inputEl.rows = 8;
						text.inputEl.cols = 40;
					});
				},
			},
			{
				name: "Apply ignored paths",
				desc: "Reindexes your vault to match the list above.",
				render: (setting) => {
					setting.addButton((button) => {
						button.setButtonText("Apply").onClick(() => {
							const ignoredPaths = parseIgnoredPaths(this.ignoredPathsDraft);
							this.deps.updateSettings({ignoredPaths})
								.then(() => {
									new Notice("Ignored paths updated. Reindexing in the background.");
								})
								.catch((error) => {
									const message = error instanceof Error ? error.message : String(error);
									new Notice(`Could not update ignored paths: ${message}`);
								});
						});
					});
				},
			},
			{
				name: "Show advanced settings",
				control: {type: "toggle", key: "advancedOpen"},
			},
			{
				type: "group",
				heading: "Advanced",
				visible: () => this.deps.settingsRepo.get().advancedOpen,
				items: [
					{
						name: "Max raw markdown characters",
						desc: "Upper bound applied before MarkdownRenderer runs.",
						control: {
							type: "number",
							key: "maxRawMarkdownChars",
							min: 1,
							validate: (value) =>
								value <= 0 ? "Max raw markdown characters must be greater than 0." : undefined,
						},
					},
					{
						name: "Max extracted characters",
						desc: "Upper bound for prepared plain text after extraction.",
						control: {
							type: "number",
							key: "maxExtractedChars",
							min: 1,
							validate: (value) =>
								value <= 0 ? "Max extracted characters must be greater than 0." : undefined,
						},
					},
					{
						name: "Max sentence overlap (%)",
						desc: `Share of a chunk's token budget reused as sentence overlap with the previous chunk (0–${MAX_OVERLAP_PERCENT}).`,
						control: {
							type: "number",
							key: "maxOverlapPercent",
							min: 0,
							max: MAX_OVERLAP_PERCENT,
							validate: (value) =>
								value < 0 || value > MAX_OVERLAP_PERCENT
									? `Max sentence overlap must be between 0 and ${MAX_OVERLAP_PERCENT}.`
									: undefined,
						},
					},
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		const settings = this.deps.settingsRepo.get();

		if (key === "advancedOpen") {
			return settings.advancedOpen;
		}
		if (key === "embeddingModelId") {
			const status = this.deps.engine.status();
			return status.kind === "ready" || status.kind === "loading" ? status.modelId : settings.embeddingModelId;
		}
		return settings[key as NumericSettingKey];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		if (key === "advancedOpen") {
			await this.deps.settingsRepo.updatePartial({advancedOpen: value as boolean});
			this.refreshDomState();
			return;
		}
		if (key === "embeddingModelId") {
			await this.switchModel(value as EmbeddingModelId);
			return;
		}
		await this.deps.updateSettings({[key]: value as number} as Partial<SimilaritySettings>);
	}

	/**
	 * Fire-and-forget: a model switch can take up to a minute, and the whole point of surfacing
	 * live status elsewhere (sidebar banner, status bar) is that the user doesn't have to sit and
	 * wait for it here — they can keep the settings tab interactive, including picking a different
	 * model before this one finishes, which cancels it. The dropdown itself always reflects
	 * `engine.status()`, so a failed switch's fallback shows up without any manual reverting.
	 */
	private async switchModel(modelId: EmbeddingModelId): Promise<void> {
		const modelLabel = EMBEDDING_MODELS[modelId].label;

		try {
			await this.deps.updateSettings({embeddingModelId: modelId});
			new Notice(`Switched to ${modelLabel}.`);
		} catch (error) {
			// The user replaced this switch by picking another model; that request reports its own result.
			if (error instanceof ModelRequestSupersededError) return;

			const message = error instanceof Error ? error.message : String(error);
			const status = this.deps.engine.status();
			const kept = status.kind === "ready" ? ` Staying on ${EMBEDDING_MODELS[status.modelId].label}.` : "";
			new Notice(`${message}${kept}`);
		}
	}
}

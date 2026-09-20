import { App, DropdownComponent, Notice, PluginSettingTab, SettingDefinitionItem } from "obsidian";
import RelatedNotes from "../main";
import { parseIgnoredPaths } from "../core/rules/ignorePaths";
import { EMBEDDING_MODELS, MAX_OVERLAP_PERCENT, SEARCH_MODES } from "../constants";
import { EmbeddingModelId, SearchMode } from "../types";
import { SettingsRepository } from "../ports";
import { UpdateSettingsUseCase } from "../app/updateSettings";
import { EngineStateReader, ModelRequestSupersededError } from "../embedding/engine";

export type SettingsViewDeps = {
	settingsRepo: SettingsRepository,
	updateSettings: UpdateSettingsUseCase,
	setSearchMode: (mode: SearchMode) => Promise<void>,
	engine: EngineStateReader,
}

type NumericSettingKey = "maxRawMarkdownChars" | "maxExtractedChars" | "maxOverlapPercent";

function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

export class SettingView extends PluginSettingTab {
	private ignoredPathsDraft: string;
	private modelDropdown?: DropdownComponent;

	constructor(
		app: App,
		plugin: RelatedNotes,
		private readonly deps: SettingsViewDeps,
	) {
		super(app, plugin);
		this.ignoredPathsDraft = this.deps.settingsRepo.get().ignoredPaths.join("\n");
		this.deps.engine.subscribe((status) => {
			this.modelDropdown?.setValue(this.currentModelId(status));
		});
	}

	private currentModelId(status = this.deps.engine.status()): EmbeddingModelId {
		return status.kind === "ready" || status.kind === "loading"
			? status.modelId
			: this.deps.settingsRepo.get().embeddingModelId;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: "Language",
				desc: "Determine which language to support. Changing this option may start an optimization process in the background. You can pick a different one before it finishes to switch again.",
				render: (setting) => {
					setting.addDropdown((dropdown) => {
						for (const model of Object.values(EMBEDDING_MODELS)) {
							dropdown.addOption(model.id, model.label);
						}
						dropdown.setValue(this.currentModelId());
						dropdown.onChange((value) => {
							void this.switchModel(value as EmbeddingModelId);
						});
						this.modelDropdown = dropdown;
					});
				},
			},
			{
				name: "Search mode",
				desc: SEARCH_MODES.map((mode) => `${mode.label}: ${mode.desc}`).join(" "),
				render: (setting) => {
					setting.addDropdown((dropdown) => {
						for (const mode of SEARCH_MODES) {
							dropdown.addOption(mode.id, capitalize(mode.label));
						}
						dropdown.setValue(this.deps.settingsRepo.get().searchMode);
						dropdown.onChange((value) => {
							void this.deps.setSearchMode(value as SearchMode);
						});
					});
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
		return settings[key as NumericSettingKey];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		if (key === "advancedOpen") {
			await this.deps.settingsRepo.updatePartial({advancedOpen: value as boolean});
			this.refreshDomState();
			return;
		}
		await this.deps.updateSettings({[key]: value as number});
	}

	/**
	 * Fire-and-forget: a model switch can take up to a minute, and the whole point of surfacing
	 * live status elsewhere (sidebar banner, status bar) is that the user doesn't have to sit and
	 * wait for it here — they can keep the settings tab interactive, including picking a different
	 * model before this one finishes, which cancels it. The dropdown's own visual revert on failure
	 * is handled by the `engine.subscribe` callback in the constructor, not here.
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
			const fallbackId = status.kind === "ready" || status.kind === "loading" ? status.modelId : null;
			const kept = fallbackId ? ` Staying on ${EMBEDDING_MODELS[fallbackId].label}.` : "";
			new Notice(`${message}${kept}`);
		}
	}
}

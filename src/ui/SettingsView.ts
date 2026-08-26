import { App, SettingDefinitionItem, DropdownComponent, Notice, PluginSettingTab, Setting } from "obsidian";
import RelatedNotes from "../main";
import { parseIgnoredPaths } from "../core/rules/ignorePaths";
import { DEFAULT_SETTINGS, EMBEDDING_MODELS, MAX_OVERLAP_PERCENT } from "../constants";
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

type IndexingDraft = {
	maxRawMarkdownChars: number;
	maxExtractedChars: number;
	maxOverlapPercent: number;
};

export class SettingView extends PluginSettingTab {
	private cachedSettings: SimilaritySettings = DEFAULT_SETTINGS;
	private ignoredPathsDraft = "";
	private indexingDraft: IndexingDraft = {
		maxRawMarkdownChars: DEFAULT_SETTINGS.maxRawMarkdownChars,
		maxExtractedChars: DEFAULT_SETTINGS.maxExtractedChars,
		maxOverlapPercent: DEFAULT_SETTINGS.maxOverlapPercent,
	};
	private embeddingModelDraft: EmbeddingModelId = DEFAULT_SETTINGS.embeddingModelId;
	private loaded = false;
	private previousModelStatus: EngineStatus["kind"] = "idle";
	private modelDropdown?: DropdownComponent;

	constructor(
		app: App,
		plugin: RelatedNotes,
		private readonly deps: SettingsViewDeps,
	) {
		super(app, plugin);
		this.preload();
		this.deps.engine.subscribe((status) => {
			if (this.previousModelStatus !== status.kind) this.update?.();
			this.previousModelStatus = status.kind;
		});
	}

	private preload() {
		const settings = this.deps.settingsRepo.get();
		this.applySettings(settings);
		this.loaded = true;
		this.update?.();
	}

	private applySettings(settings: SimilaritySettings) {
		this.cachedSettings = settings;
		this.ignoredPathsDraft = settings.ignoredPaths.join("\n");
		this.embeddingModelDraft = settings.embeddingModelId;
		this.indexingDraft = {
			maxRawMarkdownChars: settings.maxRawMarkdownChars,
			maxExtractedChars: settings.maxExtractedChars,
			maxOverlapPercent: settings.maxOverlapPercent,
		};
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
					disabled: () => !this.loaded,
				},
			},
			{
				name: "Ignored paths/folders",
				desc: "One entry per line. Folder paths ignore everything under that folder. Append .md to a filename to ignore a specific note.",
				control: {
					type: "textarea",
					key: "ignoredPathsDraft",
					placeholder: "Templates\nArchive/2023\nScratch.md",
					rows: 8,
					disabled: () => !this.loaded,
				},
			},
			{
				name: "Show advanced settings",
				control: {type: "toggle", key: "advancedOpen", disabled: () => !this.loaded},
			},
			{
				type: "group",
				heading: "Advanced",
				visible: () => this.cachedSettings.advancedOpen,
				items: [
					{
						name: "Max raw markdown characters",
						desc: "Upper bound applied before MarkdownRenderer runs.",
						control: {
							type: "number",
							key: "maxRawMarkdownChars",
							min: 1,
							disabled: () => !this.loaded,
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
							disabled: () => !this.loaded,
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
							disabled: () => !this.loaded,
							validate: (value) =>
								value < 0 || value > MAX_OVERLAP_PERCENT
									? `Max sentence overlap must be between 0 and ${MAX_OVERLAP_PERCENT}.`
									: undefined,
						},
					},
				],
			},
			{
				name: "Save settings",
				desc: "Saving updates your similarity results to match these settings.",
				render: (setting) => {
					setting.addButton((button) => {
						button.setButtonText("Save").setCta().setDisabled(!this.loaded).onClick(() => {
							const draftIgnored = parseIgnoredPaths(this.ignoredPathsDraft);
							const validationError = validateIndexingSettings(this.indexingDraft);
							if (validationError) {
								new Notice(validationError);
								return;
							}

							this.save({
								ignoredPaths: draftIgnored,
								indexing: this.indexingDraft,
								modelId: this.embeddingModelDraft,
							});
						});
					});
				},
			},
		];
	}

	getControlValue(key: string): unknown {
		if (key === "ignoredPathsDraft") {
			return this.ignoredPathsDraft;
		}
		if (key === "advancedOpen") {
			return this.cachedSettings.advancedOpen;
		}
		if (key === "embeddingModelId") {
			return this.embeddingModelDraft;
		}
		return this.indexingDraft[key as keyof IndexingDraft];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		if (key === "ignoredPathsDraft") {
			this.ignoredPathsDraft = value as string;
			return;
		}
		if (key === "advancedOpen") {
			this.cachedSettings = {...this.cachedSettings, advancedOpen: value as boolean};
			await this.deps.settingsRepo.updatePartial({advancedOpen: value as boolean});
			this.refreshDomState?.();
			return;
		}
		if (key === "embeddingModelId") {
			this.embeddingModelDraft = value as EmbeddingModelId;
			return;
		}
		this.indexingDraft = {...this.indexingDraft, [key]: value as number};
	}

	/** The model the session fell back to after `requestedId` failed, if it is falling back at all. */
	private fallbackModelId(requestedId: EmbeddingModelId): EmbeddingModelId | null {
		const status = this.deps.engine.status();
		const activeId = status.kind === "ready" || status.kind === "loading" ? status.modelId : null;

		return activeId !== null && activeId !== requestedId ? activeId : null;
	}

	private revertModelDraft(modelId: EmbeddingModelId): void {
		this.embeddingModelDraft = modelId;
		this.modelDropdown?.setValue(modelId);
		this.update?.();
	}

	/**
	 * Fire-and-forget: a model switch can take up to a minute, and the whole point of surfacing
	 * live status elsewhere (sidebar banner, status bar) is that the user doesn't have to sit and
	 * wait for it here — they can keep the settings tab interactive, including picking a different
	 * model before this one finishes, which cancels it.
	 */
	private save(draft: {
		ignoredPaths: string[];
		indexing: IndexingDraft;
		modelId: EmbeddingModelId;
	}): void {
		const modelChanged = draft.modelId !== this.cachedSettings.embeddingModelId;
		const modelLabel = EMBEDDING_MODELS[draft.modelId].label;

		const patch: Partial<SimilaritySettings> = {
			ignoredPaths: draft.ignoredPaths,
			...draft.indexing,
			...(modelChanged ? {embeddingModelId: draft.modelId} : {}),
		};

		this.deps.updateSettings(patch)
			.then(() => {
				new Notice(modelChanged ? `Switched to ${modelLabel}.` : "Settings saved. Reindexing in the background.");
			})
			.catch((error) => {
				// The user replaced this switch by picking another model; that request reports its own result.
				if (error instanceof ModelRequestSupersededError) return;

				const message = error instanceof Error ? error.message : String(error);
				if (!modelChanged) {
					new Notice(`Could not save settings: ${message}`);
					return;
				}

				// A failed switch falls back to whatever was loaded before. Put the dropdown back on
				// that model too, so the setting keeps showing the language actually in use.
				const fallbackId = this.fallbackModelId(draft.modelId);
				if (fallbackId) this.revertModelDraft(fallbackId);

				const kept = fallbackId ? ` Staying on ${EMBEDDING_MODELS[fallbackId].label}.` : "";
				new Notice(`${message}${kept}`);
			})
			.finally(() => {
				// Only re-sync what `modelChanged` is compared against. The drafts belong to the user,
				// who may have edited them while this (up to a minute long) save was in flight.
				this.cachedSettings = this.deps.settingsRepo.get();
			});
	}
}

function validateIndexingSettings(settings: Pick<
	SimilaritySettings,
	"maxRawMarkdownChars" | "maxExtractedChars" | "maxOverlapPercent"
>): string | null {
	if (settings.maxRawMarkdownChars <= 0) {
		return "Max raw markdown characters must be greater than 0.";
	}
	if (settings.maxExtractedChars <= 0) {
		return "Max extracted characters must be greater than 0.";
	}
	if (settings.maxOverlapPercent < 0 || settings.maxOverlapPercent > MAX_OVERLAP_PERCENT) {
		return `Max sentence overlap must be between 0 and ${MAX_OVERLAP_PERCENT}.`;
	}
	return null;
}

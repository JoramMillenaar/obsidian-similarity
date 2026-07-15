import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import RelatedNotes from "../main";
import { parseIgnoredPaths } from "../domain/ignoreRules";
import { MAX_CENTROID_SEARCH_STEPS, MAX_OVERLAP_PERCENT } from "../constants";
import { SimilaritySettings } from "../types";
import { SettingsRepository } from "../ports";
import { UpdateSettingsUseCase } from "../app/updateSettings";

export type SettingsViewDeps = {
	settingsRepo: SettingsRepository,
	updateSettings: UpdateSettingsUseCase,
}


export class SettingView extends PluginSettingTab {
	constructor(
		app: App,
		plugin: RelatedNotes,
		private readonly deps: SettingsViewDeps,
	) {
		super(app, plugin);
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		void this.render(containerEl);
	}

	private async render(containerEl: HTMLElement) {
		const settings = await this.deps.settingsRepo.get();
		let draftIgnored = settings.ignoredPaths;
		let advancedOpen = settings.advancedOpen;
		const draftIndexing = {
			maxRawMarkdownChars: settings.maxRawMarkdownChars,
			maxExtractedChars: settings.maxExtractedChars,
			maxOverlapPercent: settings.maxOverlapPercent,
			titleWeight: settings.titleWeight,
			centroidSearchSteps: settings.centroidSearchSteps,
			centroidMinChars: settings.centroidMinChars,
		};

		new Setting(containerEl)
			.setName("Ignored paths/folders")
			.setDesc("One entry per line. Folder paths ignore everything under that folder. Append .md to a filename to ignore a specific note.")
			.addTextArea((text) => {
				text
					.setPlaceholder("Templates\nArchive/2023\nScratch.md")
					.setValue(draftIgnored.join("\n"))
					.onChange((value) => {
						draftIgnored = parseIgnoredPaths(value);
					});
				text.inputEl.rows = 8;
				text.inputEl.cols = 40;
			});

		const advancedSection = containerEl.createDiv("similarity-setting-section");
		const advancedHeading = new Setting(advancedSection)
			.setName("Advanced")
			.setHeading()
			.setClass("similarity-setting-section-heading");
		advancedHeading.settingEl.tabIndex = 0;
		advancedHeading.settingEl.setAttr("role", "button");

		const advancedBody = advancedSection.createDiv("similarity-setting-section-body");
		const renderAdvancedSection = () => {
			advancedBody.style.display = advancedOpen ? "block" : "none";
			advancedHeading.settingEl.toggleClass("is-open", advancedOpen);
			advancedHeading.settingEl.setAttr("aria-expanded", String(advancedOpen));
		};
		const toggleAdvancedSection = async () => {
			advancedOpen = !advancedOpen;
			await this.deps.settingsRepo.updatePartial({advancedOpen});
			renderAdvancedSection();
		};

		advancedHeading.settingEl.addEventListener("click", () => {
			void toggleAdvancedSection();
		});
		advancedHeading.settingEl.addEventListener("keydown", (event: KeyboardEvent) => {
			if (event.key !== "Enter" && event.key !== " ") {
				return;
			}

			event.preventDefault();
			void toggleAdvancedSection();
		});

		this.addNumericSetting(
			advancedBody,
			"Max raw markdown characters",
			"Upper bound applied before MarkdownRenderer runs.",
			settings.maxRawMarkdownChars,
			(value) => {
				draftIndexing.maxRawMarkdownChars = value;
			},
		);
		this.addNumericSetting(
			advancedBody,
			"Max extracted characters",
			"Upper bound for prepared plain text after extraction and title weighting.",
			settings.maxExtractedChars,
			(value) => {
				draftIndexing.maxExtractedChars = value;
			},
		);
		this.addNumericSetting(
			advancedBody,
			"Max sentence overlap (%)",
			`Share of a chunk's token budget reused as sentence overlap with the previous chunk (0–${MAX_OVERLAP_PERCENT}).`,
			settings.maxOverlapPercent,
			(value) => {
				draftIndexing.maxOverlapPercent = value;
			},
		);
		this.addNumericSetting(
			advancedBody,
			"Title weight",
			"How many times the note title is prepended before chunking.",
			settings.titleWeight,
			(value) => {
				draftIndexing.titleWeight = value;
			},
		);
		this.addNumericSetting(
			advancedBody,
			"Description search steps",
			`How many times a note's text is halved to home in on its most representative passage (0–${MAX_CENTROID_SEARCH_STEPS}). Each step costs two embeddings per note.`,
			settings.centroidSearchSteps,
			(value) => {
				draftIndexing.centroidSearchSteps = value;
			},
		);
		this.addNumericSetting(
			advancedBody,
			"Minimum description length",
			"Descriptions keep taking whole sentences until they reach this many characters.",
			settings.centroidMinChars,
			(value) => {
				draftIndexing.centroidMinChars = value;
			},
		);
		renderAdvancedSection();

		new Setting(containerEl)
			.setName("Save settings")
			.setDesc("Saving updates your similarity results to match these settings.")
			.addButton((button) => {
				button.setButtonText("Save").setCta().onClick(async () => {
					button.setDisabled(true);
					try {
						const validationError = validateIndexingSettings(draftIndexing);
						if (validationError) {
							new Notice(validationError);
							return;
						}

						const result = await this.deps.updateSettings({
							ignoredPaths: draftIgnored,
							...draftIndexing,
						});
						if (result.reindexQueued) {
							new Notice("Settings saved. Index rebuild queued in the background.");
						} else {
							new Notice("Settings saved.");
						}
					} finally {
						button.setDisabled(false);
					}
				});
			});
	}

	private addNumericSetting(
		containerEl: HTMLElement,
		name: string,
		description: string,
		initialValue: number,
		onChange: (value: number) => void,
	) {
		new Setting(containerEl)
			.setName(name)
			.setDesc(description)
			.addText((text) => {
				text
					.setPlaceholder(String(initialValue))
					.setValue(String(initialValue))
					.onChange((value) => {
						const parsed = Number.parseInt(value, 10);
						if (Number.isFinite(parsed)) {
							onChange(parsed);
						}
					});
				text.inputEl.inputMode = "numeric";
			});
	}
}

function validateIndexingSettings(settings: Pick<
	SimilaritySettings,
	"maxRawMarkdownChars" | "maxExtractedChars" | "maxOverlapPercent" | "titleWeight"
	| "centroidSearchSteps" | "centroidMinChars"
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
	if (settings.titleWeight < 0) {
		return "Title weight cannot be negative.";
	}
	if (settings.centroidSearchSteps < 0 || settings.centroidSearchSteps > MAX_CENTROID_SEARCH_STEPS) {
		return `Description search steps must be between 0 and ${MAX_CENTROID_SEARCH_STEPS}.`;
	}
	if (settings.centroidMinChars <= 0) {
		return "Minimum description length must be greater than 0.";
	}

	return null;
}

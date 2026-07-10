import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import RelatedNotes from "../main";
import { parseIgnoredPaths } from "../domain/ignoreRules";
import { IndexBackend, SimilaritySettings } from "../types";
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
		let draftIndexBackend: IndexBackend = settings.indexBackend;
		const draftIndexing = {
			maxRawMarkdownChars: settings.maxRawMarkdownChars,
			maxExtractedChars: settings.maxExtractedChars,
			maxChunks: settings.maxChunks,
			titleWeight: settings.titleWeight,
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

		new Setting(advancedBody)
			.setName("Index storage")
			.setDesc("JSON keeps the index in the plugin data file. Binary keeps a compact binary index file in the plugin folder, using less memory in large vaults. Iodb keeps a crash-safe binary database file in the plugin folder. Switching migrates your existing index automatically—no re-indexing needed.")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("json", "JSON (plugin data)")
					.addOption("binary", "Binary (compact file)")
					.addOption("iodb", "Iodb (crash-safe database)")
					.setValue(draftIndexBackend)
					.onChange((value) => {
						draftIndexBackend = value === "binary" || value === "iodb" ? value : "json";
					});
			});
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
			"Max chunks",
			"Maximum embedding chunks kept per note after chunking.",
			settings.maxChunks,
			(value) => {
				draftIndexing.maxChunks = value;
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
							indexBackend: draftIndexBackend,
							...draftIndexing,
						});
						if (result.backendMigrated) {
							new Notice("Settings saved. Index migrated to the new storage backend.");
						} else if (result.reindexQueued) {
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
	"maxRawMarkdownChars" | "maxExtractedChars" | "maxChunks" | "titleWeight"
>): string | null {
	if (settings.maxRawMarkdownChars <= 0) {
		return "Max raw markdown characters must be greater than 0.";
	}
	if (settings.maxExtractedChars <= 0) {
		return "Max extracted characters must be greater than 0.";
	}
	if (settings.maxChunks <= 0) {
		return "Max chunks must be greater than 0.";
	}
	if (settings.titleWeight < 0) {
		return "Title weight cannot be negative.";
	}

	return null;
}

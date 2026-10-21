import { App, Notice, PluginSettingTab, Setting, setIcon, SettingDefinitionItem, TFolder, ToggleComponent } from "obsidian";
import SimilarNotes from "../main";
import { SEARCH_MODES } from "../constants";
import { SearchMode } from "../types";
import { SettingsRepository } from "../ports";
import { UpdateSettingsUseCase } from "../app/updateSettings";
import { EngineStateReader, EngineStatus, ModelRequestSupersededError } from "../embedding/engine";
import { FEEDBACK_ACTIONS, OpenFeedback } from "./FeedbackModal";
import { createWarningIcon } from "./warning";
import { IgnorePathSuggest } from "./IgnorePathSuggest";

export type SettingsViewDeps = {
	settingsRepo: SettingsRepository,
	updateSettings: UpdateSettingsUseCase,
	setSearchMode: (mode: SearchMode) => Promise<void>,
	setModelDisabled: (disabled: boolean) => Promise<void>,
	engine: EngineStateReader,
	openFeedback: OpenFeedback,
}

type NumericSettingKey = "maxRawMarkdownChars" | "maxExtractedChars";

function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

export class SettingView extends PluginSettingTab {
	private modelDisabledToggle?: ToggleComponent;
	private modelDisabledSettingEl?: HTMLElement;

	constructor(
		app: App,
		plugin: SimilarNotes,
		private readonly deps: SettingsViewDeps,
	) {
		super(app, plugin);
		this.deps.engine.subscribe((status) => {
			this.reflectModelDisabled(status);
		});
	}

	private isModelDisabled(status = this.deps.engine.status()): boolean {
		return status.kind === "disabled";
	}

	/**
	 * The disabled state can change from outside this tab (it may be tripped for the user, not
	 * by them), so everything that depends on it is synced from engine status, not from the
	 * toggle's own onChange.
	 */
	private reflectModelDisabled(status: EngineStatus): void {
		const disabled = this.isModelDisabled(status);
		// ToggleComponent.setValue fires onChange, so only touch it when it actually differs.
		if (this.modelDisabledToggle && this.modelDisabledToggle.getValue() !== disabled) {
			this.modelDisabledToggle.setValue(disabled);
		}
		this.modelDisabledSettingEl?.toggleClass("similarity-setting-warning", disabled);
		if (this.containerEl?.isConnected) this.refreshDomState();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const {ignoredPaths} = this.deps.settingsRepo.get();

		return [
			{
				name: "Search mode",
				render: (setting) => {
					const describe = (id: string) => setting.setDesc(SEARCH_MODES.find((mode) => mode.id === id)?.desc ?? "");
					setting.addDropdown((dropdown) => {
						for (const mode of SEARCH_MODES) {
							dropdown.addOption(mode.id, capitalize(mode.label));
						}
						dropdown.setValue(this.deps.settingsRepo.get().searchMode);
						describe(dropdown.getValue());
						dropdown.onChange((value) => {
							describe(value);
							void this.deps.setSearchMode(value as SearchMode);
						});
					});
				},
			},
			{
				type: "page",
				name: "Ignored folders and notes",
				desc: "Left out of similar notes and search.",
				displayValue: () => ignoredPaths.length ? String(ignoredPaths.length) : "None",
				items: [
					{
						name: "Add folder or note",
						render: (setting) => {
							setting.settingEl.addClass("similarity-path-search-setting");
							setting.addSearch((search) => {
								search.setPlaceholder("Find or type a folder or note to ignore…");
								new IgnorePathSuggest(this.app, search.inputEl, this.deps.settingsRepo.get().ignoredPaths, (path) => {
									void this.addIgnoredPath(path);
								});
							});
						},
					},
					{
						type: "list",
						emptyState: "Nothing is ignored.",
						onDelete: (index) => {
							void this.removeIgnoredPath(ignoredPaths[index]);
						},
						items: ignoredPaths.map((path) => ({
							name: path,
							render: (setting: Setting) => {
								const icon = this.ignoredPathIcon(path);
								setting.setName(path);
								setIcon(setting.nameEl.createSpan({cls: "similarity-ignored-path-icon"}), icon.name);
								setting.nameEl.prepend(setting.nameEl.lastElementChild!);
								setting.nameEl.setAttr("aria-label", icon.label);
							},
						})),
					},
				],
			},
			{
				name: "Feedback",
				desc: "Found a bug or have an idea? Reports open in your browser or mail client, so you see exactly what is sent.",
				render: (setting) => {
					setting.settingEl.addClass("similarity-feedback-setting");
					for (const action of FEEDBACK_ACTIONS) {
						setting.addButton((button) => {
							button.setButtonText(action.label).onClick(() => action.run(this.deps.openFeedback));
						});
					}
				},
			},
			{
				name: "Show advanced settings",
				control: {type: "toggle", key: "advancedOpen", disabled: () => this.isModelDisabled()},
			},
			{
				type: "group",
				heading: "Advanced",
				// Forced open while the model is disabled so the warning below can't be missed.
				visible: () => this.deps.settingsRepo.get().advancedOpen || this.isModelDisabled(),
				items: [
					{
						name: "Disable local AI on this device",
						desc: "Turns the AI model off on this device only (this setting is not synced). Similar notes keep working from what was already indexed, but nothing new is indexed and text search is unavailable. Use this if the model crashes or slows this device down.",
						render: (setting) => {
							setting.addToggle((toggle) => {
								toggle.setValue(this.isModelDisabled());
								toggle.onChange((value) => {
									void this.setModelDisabled(value);
								});
								this.modelDisabledToggle = toggle;
							});
							setting.nameEl.prepend(createWarningIcon(setting.nameEl));
							this.modelDisabledSettingEl = setting.settingEl;
							setting.settingEl.toggleClass("similarity-setting-warning", this.isModelDisabled());
							return () => {
								this.modelDisabledToggle = undefined;
								this.modelDisabledSettingEl = undefined;
							};
						},
					},
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
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		const settings = this.deps.settingsRepo.get();

		if (key === "advancedOpen") {
			return settings.advancedOpen || this.isModelDisabled();
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

	private ignoredPathIcon(path: string): {name: string, label: string} {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!file) return {name: "file-question", label: "Not found in this vault"};
		return file instanceof TFolder ? {name: "folder", label: "Folder"} : {name: "file-text", label: "Note"};
	}

	private async addIgnoredPath(path: string): Promise<void> {
		const {ignoredPaths} = this.deps.settingsRepo.get();
		if (ignoredPaths.includes(path)) return;
		await this.commitIgnoredPaths([...ignoredPaths, path], `Ignoring "${path}".`);
	}

	private async removeIgnoredPath(path: string): Promise<void> {
		const {ignoredPaths} = this.deps.settingsRepo.get();
		if (!ignoredPaths.includes(path)) return;
		await this.commitIgnoredPaths(ignoredPaths.filter((ignored) => ignored !== path), `No longer ignoring "${path}".`);
	}

	private async commitIgnoredPaths(ignoredPaths: string[], summary: string): Promise<void> {
		try {
			await this.deps.updateSettings({ignoredPaths});
			new Notice(`${summary} Reindexing in the background.`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`Could not update ignored paths: ${message}`);
		}
		// Adding or removing entries changes the definitions themselves, so re-render rather than refreshDomState().
		this.update();
	}

	private async setModelDisabled(disabled: boolean): Promise<void> {
		try {
			await this.deps.setModelDisabled(disabled);
		} catch (error) {
			if (error instanceof ModelRequestSupersededError) return;
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`Could not ${disabled ? "disable" : "enable"} the model: ${message}`);
		}
	}
}

import { AbstractInputSuggest, App, prepareFuzzySearch, setIcon, TAbstractFile, TFolder } from "obsidian";
import { isPathIgnored, normalizePath } from "../core/rules/ignorePaths";

type Candidate = {path: string, icon: string};

const MAX_SUGGESTIONS = 50;

export class IgnorePathSuggest extends AbstractInputSuggest<Candidate> {
	constructor(
		app: App,
		inputEl: HTMLInputElement,
		private readonly ignoredPaths: string[],
		onChoose: (path: string) => void,
	) {
		super(app, inputEl);
		this.limit = MAX_SUGGESTIONS;
		this.onSelect((candidate) => onChoose(candidate.path));
	}

	protected getSuggestions(query: string): Candidate[] {
		const typed = normalizePath(query);
		if (!typed) return this.candidates();

		const matches = this.candidates()
			.map((candidate) => ({candidate, result: prepareFuzzySearch(typed)(candidate.path)}))
			.filter(({result}) => result !== null)
			.sort((left, right) => right.result!.score - left.result!.score)
			.map(({candidate}) => candidate);

		const known = matches.some((candidate) => candidate.path === typed) || isPathIgnored(typed, this.ignoredPaths);
		return known ? matches : [...matches, {path: typed, icon: "file-question"}];
	}

	renderSuggestion(candidate: Candidate, el: HTMLElement): void {
		el.addClass("similarity-path-suggestion");
		setIcon(el.createSpan({cls: "similarity-path-suggestion-icon"}), candidate.icon);
		el.createDiv({cls: "similarity-path-suggestion-text", text: candidate.path});
	}

	private candidates(): Candidate[] {
		const {vault} = this.app;
		const byPath = (left: TAbstractFile, right: TAbstractFile) => left.path.localeCompare(right.path);
		return [...vault.getAllFolders().sort(byPath), ...vault.getMarkdownFiles().sort(byPath)]
			.filter((file) => file.path !== "/" && !isPathIgnored(file.path, this.ignoredPaths))
			.map((file) => ({path: file.path, icon: file instanceof TFolder ? "folder" : "file-text"}));
	}
}

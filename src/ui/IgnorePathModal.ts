import { App, FuzzyMatch, FuzzySuggestModal, setIcon, TAbstractFile, TFolder } from "obsidian";
import { isPathIgnored, normalizePath } from "../core/rules/ignorePaths";

type Candidate = {path: string, icon: string};

export class IgnorePathModal extends FuzzySuggestModal<Candidate> {
	private readonly ignoredPaths: string[];
	private readonly items: Candidate[];

	constructor(
		app: App,
		ignoredPaths: string[],
		private readonly onChoose: (path: string) => void,
	) {
		super(app);
		const byPath = (left: TAbstractFile, right: TAbstractFile) => left.path.localeCompare(right.path);
		this.items = [...app.vault.getAllFolders().sort(byPath), ...app.vault.getMarkdownFiles().sort(byPath)]
			.filter((file) => !isPathIgnored(file.path, ignoredPaths))
			.map((file) => ({path: file.path, icon: file instanceof TFolder ? "folder" : "file-text"}));
		this.ignoredPaths = ignoredPaths;

		this.setPlaceholder("Find or type a folder or note to ignore…");
		this.emptyStateText = "No matching folders or notes.";
		this.setInstructions([
			{command: "↑↓", purpose: "navigate"},
			{command: "↵", purpose: "ignore"},
			{command: "esc", purpose: "close"},
		]);
	}

	getItems(): Candidate[] {
		return this.items;
	}

	getItemText(item: Candidate): string {
		return item.path;
	}

	getSuggestions(query: string): FuzzyMatch<Candidate>[] {
		const suggestions = super.getSuggestions(query);
		const path = normalizePath(query);
		if (path && !isPathIgnored(path, this.ignoredPaths) && !this.items.some((item) => item.path === path)) {
			suggestions.push({item: {path, icon: "file-question"}, match: {score: 0, matches: []}});
		}
		return suggestions;
	}

	renderSuggestion(match: FuzzyMatch<Candidate>, el: HTMLElement): void {
		el.addClass("similarity-path-suggestion");
		setIcon(el.createSpan({cls: "similarity-path-suggestion-icon"}), match.item.icon);
		super.renderSuggestion(match, el.createDiv({cls: "similarity-path-suggestion-text"}));
	}

	onChooseItem(item: Candidate): void {
		this.onChoose(item.path);
	}
}

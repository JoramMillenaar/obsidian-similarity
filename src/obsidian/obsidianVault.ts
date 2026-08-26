import { Component, EditorPosition, MarkdownRenderer, MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { NoteIndexCandidate, RawNote } from "../types";
import { ActivateOptions, Vault } from "../ports";
import { neutralize } from "../core/text/neutralize";
import { extractText } from "../core/text/extract";
import { VIEW_TYPE_SIMILARITY } from "../constants";

export class ObsidianVault implements Vault {
	constructor(private readonly plugin: Plugin) {
	}

	async getNote(noteId: string): Promise<RawNote | null> {
		const file = this.plugin.app.vault.getAbstractFileByPath(noteId);
		if (!(file instanceof TFile)) return null;

		return {
			id: noteId,
			title: file.basename,
			markdown: await this.plugin.app.vault.read(file),
		};
	}

	listNoteIds(): string[] {
		return this.plugin.app.vault.getMarkdownFiles().map((file) => file.path);
	}

	listIndexCandidates(): NoteIndexCandidate[] {
		const recentFiles = this.plugin.app.workspace.getLastOpenFiles();
		const recentOpenRanks = new Map(recentFiles.map((path, index) => [path, index]));

		return this.plugin.app.vault.getMarkdownFiles().map((file) => ({
			id: file.path,
			modifiedAt: file.stat.mtime,
			recentOpenRank: recentOpenRanks.get(file.path),
		}));
	}

	async extractText(markdown: string, sourcePath = ""): Promise<string> {
		const el = createDiv();
		const component = new Component();
		component.load();

		try {
			await MarkdownRenderer.render(
				this.plugin.app,
				neutralize(markdown),
				el,
				sourcePath,
				component,
			);
			return extractText(el);
		} finally {
			component.unload();
		}
	}

	insertTextAtCursor(text: string): boolean {
		const markdownView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		const editor = markdownView?.editor;
		if (!editor) return false;

		const cursor = editor.getCursor();
		editor.replaceRange(text, cursor);

		const newCursor: EditorPosition = {line: cursor.line, ch: cursor.ch + text.length};
		editor.setCursor(newCursor);

		return true;
	}

	async activateSimilarityView(options: ActivateOptions = {}): Promise<void> {
		const {workspace} = this.plugin.app;
		const {reveal = true, focus = false} = options;

		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_SIMILARITY)[0];

		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			if (!leaf) {
				new Notice("Unable to activate similarity view.");
				return;
			}

			await leaf.setViewState({type: VIEW_TYPE_SIMILARITY, active: reveal || focus});
		}

		if (reveal) await workspace.revealLeaf(leaf);
		if (focus) workspace.setActiveLeaf(leaf, {focus: true});
	}
}

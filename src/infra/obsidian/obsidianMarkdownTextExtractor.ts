import { Component, MarkdownRenderer, Plugin } from "obsidian";
import { MarkdownTextExtractor } from "../../ports";
import { neutralize } from "../../domain/neutralize";
import { extractText } from "../../domain/extract";

export class ObsidianMarkdownTextExtractor implements MarkdownTextExtractor {
	constructor(private readonly plugin: Plugin) {
	}

	async extract(markdown: string, sourcePath = ""): Promise<string> {
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
}

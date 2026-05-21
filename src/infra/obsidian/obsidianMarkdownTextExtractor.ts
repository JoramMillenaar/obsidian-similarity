import { Component, MarkdownRenderer, Plugin } from "obsidian";
import { MarkdownTextExtractor } from "../../ports";

export class ObsidianMarkdownTextExtractor implements MarkdownTextExtractor {
	constructor(private readonly plugin: Plugin) {
	}

	async extract(markdown: string): Promise<string> {
		const el = createDiv();
		const component = new Component();

		try {
			await MarkdownRenderer.render(
				this.plugin.app,
				convertMarkdownTableToText(markdown),
				el,
				"",
				component,
			);
			return (el.textContent ?? "").trim();
		} finally {
			component.unload();
		}
	}
}

function convertMarkdownTableToText(markdown: string): string {
	const lines = markdown.split("\n");
	const tableLines = lines.filter((line) => line.includes("|"));

	if (tableLines.length < 2) return markdown;

	const [headerLine, separatorLine, ...dataLines] = tableLines;
	if (!separatorLine.includes("-")) return markdown;

	const headers = headerLine
		.split("|")
		.map((cell) => cell.trim())
		.filter(Boolean);

	const rows = dataLines.map((line) =>
		line
			.split("|")
			.map((cell) => cell.trim())
			.filter(Boolean),
	);

	const plainText = rows
		.map((row) =>
			headers
				.map((header, index) => `${header}: ${row[index] ?? ""}`)
				.join(", "),
		)
		.join(". ");

	return markdown.replace(tableLines.join("\n"), plainText);
}

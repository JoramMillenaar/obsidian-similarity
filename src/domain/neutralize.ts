import { getFrontMatterInfo } from "obsidian";

export function neutralize(markdown: string): string {
	const fm = getFrontMatterInfo(markdown);
	let md = fm.exists ? markdown.slice(fm.contentStart) : markdown;
	md = stripFencedCode(md);      // kills every block code-processor
	md = neutralizeInlineCode(md); // kills inline `= ` / `$= ` queries
	md = md.replace(/!\[\[/g, "[["); // transclusion -> link
	return md;
}

export function stripFencedCode(md: string): string {
	const out: string[] = [];
	let fence: string | null = null;

	for (const line of md.split("\n")) {
		const m = line.match(/^\s{0,3}(`{3,}|~{3,})/);
		if (fence === null) {
			if (m) {
				fence = m[1];
				continue;
			}
			out.push(line);
		} else if (m && m[1][0] === fence[0] && m[1].length >= fence.length) {
			fence = null;
		}
	}
	return out.join("\n");
}

// Keep the words, defuse the syntax: escaping every ASCII punctuation mark
// means the body renders as literal text and can't become a link or a query.
export function neutralizeInlineCode(md: string): string {
	return md.replace(/(`+)([^\n]*?)\1/g, (_full, _ticks, body: string) =>
		body.replace(/[\\`*_{}\[\]()#+\-.!|~^=<>$]/g, "\\$&"));
}

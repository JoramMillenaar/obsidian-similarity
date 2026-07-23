const SKIP = [
	".copy-code-button", ".footnote-backref", ".collapse-indicator",
	".callout-fold", ".internal-embed", ".metadata-container",
	".mod-header", ".mod-footer",
].join(",");

const BLOCK = new Set([
	"P", "DIV", "LI", "UL", "OL", "BLOCKQUOTE", "PRE", "HR", "BR", "SECTION",
	"ARTICLE", "FIGURE", "FIGCAPTION", "DETAILS", "SUMMARY",
	"H1", "H2", "H3", "H4", "H5", "H6",
]);

export function extractText(root: HTMLElement): string {
	const parts: string[] = [];
	walk(root, parts);
	return parts.join("")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function walk(node: Node, out: string[]): void {
	if (node.nodeType === Node.TEXT_NODE) {
		out.push(node.nodeValue ?? "");
		return;
	}
	if (!(node instanceof HTMLElement) || node.matches(SKIP)) return;

	if (node.tagName === "TABLE") {
		out.push(tableToText(node));
		return;
	}
	if (node.tagName === "IMG") {
		const alt = node.getAttribute("alt");
		if (alt) out.push(alt);
		return;
	}

	const block = BLOCK.has(node.tagName);
	if (block) out.push("\n");
	node.childNodes.forEach((child) => walk(child, out));
	if (block) out.push("\n");
}

export function tableToText(table: HTMLElement): string {
	const headers = Array.from(table.querySelectorAll("thead th"))
		.map((th) => (th.textContent ?? "").trim());
	const rows = Array.from(table.querySelectorAll("tbody tr"))
		.map((tr) => Array.from(tr.children).map((td) => (td.textContent ?? "").trim()));

	const lines = headers.length
		? rows.map((r) => headers.map((h, i) => `${h}: ${r[i] ?? ""}`).join(", "))
		: rows.map((r) => r.join(", "));

	return `\n${lines.join(". ")}\n`;
}

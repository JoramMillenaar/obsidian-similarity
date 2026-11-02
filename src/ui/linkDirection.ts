export type LinkDirection = "none" | "outgoing" | "backlink" | "both";

/** Shape of `metadataCache.resolvedLinks`: source path → destination path → link count. */
export type ResolvedLinks = Record<string, Record<string, number> | undefined>;

export function linkDirection(resolvedLinks: ResolvedLinks, activePath: string, notePath: string): LinkDirection {
	const outgoing = (resolvedLinks[activePath]?.[notePath] ?? 0) > 0;
	const backlink = (resolvedLinks[notePath]?.[activePath] ?? 0) > 0;
	if (outgoing && backlink) return "both";
	if (outgoing) return "outgoing";
	if (backlink) return "backlink";
	return "none";
}

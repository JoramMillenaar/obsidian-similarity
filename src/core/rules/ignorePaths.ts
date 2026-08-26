export function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").trim();
}

export function parseIgnoredPaths(input: string): string[] {
	return Array.from(
		new Set(
			input
				.split("\n")
				.map((line) => normalizePath(line))
				.filter(Boolean),
		),
	);
}

export function isPathIgnored(notePath: string, ignoredPaths: string[]): boolean {
	const normalizedNotePath = normalizePath(notePath);

	for (const rawIgnoredPath of ignoredPaths) {
		const ignoredPath = normalizePath(rawIgnoredPath);
		if (!ignoredPath) continue;

		if (normalizedNotePath === ignoredPath) return true;
		if (normalizedNotePath.startsWith(`${ignoredPath}/`)) return true;
	}

	return false;
}

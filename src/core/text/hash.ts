export function hashText(text: string): string {
	let hash = 0x811c9dc5;

	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

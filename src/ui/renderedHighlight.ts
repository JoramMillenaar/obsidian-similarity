import { locatePassage } from "../core/text/locatePassage";

/** The CSS custom highlight a matched passage gets in rendered markdown (styled in styles.css). */
const TARGET_HIGHLIGHT = "similarity-target";

/** The project's DOM typings predate the registry's map and the highlight's set methods, which Electron's Chromium has. */
type RangeSet = { add(range: Range): void; delete(range: Range): boolean };
const highlights = () => CSS.highlights as unknown as Map<string, RangeSet>;

/**
 * Marks `passage` in the rendered markdown under `root` once it's rendered there (reading view
 * renders lazily, so this retries as the DOM changes), and keeps core's block flash off meanwhile,
 * which would compete with the mark. `onMarked` gets the marked range. Returns what removes the mark.
 */
export function markRenderedPassage(root: HTMLElement, passage: Promise<string | null>, onMarked?: (range: Range) => void): () => void {
	let range: Range | null = null;
	let stopped = false;
	const observer = new MutationObserver(() => tryMark());
	const stopFlash = suppressBlockFlash(root);

	const tryMark = () => {
		if (stopped || range) return;
		void passage.then((text) => {
			if (stopped || range || !text) return;
			const container = root.querySelector<HTMLElement>(".markdown-preview-view") ?? root;
			range = rangeOf(container, text);
			if (!range) return;

			observer.disconnect();
			const highlight = highlights().get(TARGET_HIGHLIGHT) ?? (new Highlight() as unknown as RangeSet);
			highlight.add(range);
			highlights().set(TARGET_HIGHLIGHT, highlight);
			onMarked?.(range);
		});
	};

	observer.observe(root, {childList: true, subtree: true, characterData: true});
	tryMark();

	return () => {
		stopped = true;
		observer.disconnect();
		stopFlash();
		if (range) highlights().get(TARGET_HIGHLIGHT)?.delete(range);
	};
}

/**
 * Core flashes the whole block it scrolls rendered markdown to (`state.scroll`, or a search match).
 * The class is taken off as soon as it's added, before it's ever painted.
 */
function suppressBlockFlash(root: HTMLElement): () => void {
	for (const flashing of root.findAll(".is-flashing")) flashing.removeClass("is-flashing");
	const observer = new MutationObserver((mutations) => {
		for (const {target} of mutations) {
			if (target.instanceOf(HTMLElement) && target.hasClass("is-flashing")) target.removeClass("is-flashing");
		}
	});
	observer.observe(root, {subtree: true, attributes: true, attributeFilter: ["class"]});
	return () => observer.disconnect();
}

/** The DOM range holding a passage of rendered text, matched by its words like {@link locatePassage}. */
function rangeOf(container: HTMLElement, passage: string): Range | null {
	const nodes: Text[] = [];
	const starts: number[] = [];
	let text = "";
	const walker = container.doc.createTreeWalker(container, NodeFilter.SHOW_TEXT);
	while (walker.nextNode()) {
		const node = walker.currentNode as Text;
		// Text nodes are joined by a break, so words of adjacent blocks don't run together.
		if (nodes.length) text += "\n";
		starts.push(text.length);
		nodes.push(node);
		text += node.data;
	}

	const found = locatePassage(text, passage);
	if (!found) return null;

	const at = (offset: number, isEnd: boolean): [Text, number] => {
		let i = nodes.length - 1;
		while (i > 0 && (isEnd ? starts[i] >= offset : starts[i] > offset)) i--;
		return [nodes[i], Math.min(offset - starts[i], nodes[i].data.length)];
	};
	const range = container.doc.createRange();
	range.setStart(...at(found[0], false));
	range.setEnd(...at(found[1], true));
	return range;
}

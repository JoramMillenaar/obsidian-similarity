// Passages are cut from a note's rendered text (see app/getNoteText.ts), where markup is gone, a link
// shows its alias and code is dropped. So a passage is found in the markdown by its words, in order:
// markdown words the passage lacks (link targets, URLs) are stepped over, and so are passage words the
// markdown lacks nearby (e.g. table headers, which the rendered text repeats on every row).

type Word = { text: string; start: number; end: number };

const wordSegmenter = new Intl.Segmenter("und", {granularity: "word"});

/** How many leading passage words a match may start from, in case the first ones aren't in the markdown. */
const ANCHOR_WORDS = 3;
/** How far a missing word is searched for, and how many in a row may be missing, before a match ends. */
const MAX_GAP_WORDS = 8;
/** The share of the passage's words a match must find. */
const MIN_FOUND = 0.6;

function wordsOf(text: string): Word[] {
	const words: Word[] = [];
	for (const {segment, index, isWordLike} of wordSegmenter.segment(text)) {
		if (isWordLike) words.push({text: segment.toLowerCase(), start: index, end: index + segment.length});
	}
	return words;
}

/** Where a passage of a note's rendered text lies in its markdown, as [start, end) offsets; null if it can't be found. */
export function locatePassage(markdown: string, passage: string): [number, number] | null {
	const exact = markdown.indexOf(passage);
	if (passage && exact >= 0) return [exact, exact + passage.length];

	const needle = wordsOf(passage);
	if (!needle.length) return null;
	const hay = wordsOf(markdown);

	let best: { found: number; first: number; last: number } | null = null;
	for (let h = 0; h < hay.length; h++) {
		for (let k = 0; k < Math.min(ANCHOR_WORDS, needle.length); k++) {
			if (hay[h].text !== needle[k].text) continue;
			const match = alignFrom(hay, h, needle, k);
			if (!best || match.found > best.found) best = match;
		}
	}

	if (!best || best.found < Math.ceil(needle.length * MIN_FOUND)) return null;
	return [hay[best.first].start, hay[best.last].end];
}

function alignFrom(hay: Word[], h: number, needle: Word[], n: number): { found: number; first: number; last: number } {
	const first = h;
	let last = h;
	let found = 0;
	let missing = 0;
	while (h < hay.length && n < needle.length) {
		if (hay[h].text === needle[n].text) {
			found++;
			last = h;
			h++;
			n++;
			missing = 0;
			continue;
		}
		const ahead = indexAhead(hay, h + 1, needle[n].text);
		if (ahead >= 0) {
			h = ahead;
			continue;
		}
		n++;
		if (++missing > MAX_GAP_WORDS) break;
	}
	return {found, first, last};
}

function indexAhead(hay: Word[], from: number, text: string): number {
	const end = Math.min(hay.length, from + MAX_GAP_WORDS);
	for (let i = from; i < end; i++) {
		if (hay[i].text === text) return i;
	}
	return -1;
}

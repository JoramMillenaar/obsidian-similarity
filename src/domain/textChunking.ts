export const MAX_OVERLAP_PERCENT = 50;

export interface Sentence {
	text: string;
	start: number;
	end: number;
}

export interface TextChunk {
	text: string;
	start: number;
	end: number;
	canonicalStart: number;
	canonicalEnd: number;
	tokens: number;
}

export type TokenCounter = (text: string) => number;

interface Atom extends Sentence {
	tokens: number;
}

// Yields each sentence with its span in `text`. Offsets are of the TRIMMED
// sentence, so a chunk's [start, end) maps back onto the caller's own string.
const sentenceSegmenter = new Intl.Segmenter('und', {granularity: 'sentence'});

export function segmentSentences(text: string): Sentence[] {
	const sentences: Sentence[] = [];
	for (const {segment, index} of sentenceSegmenter.segment(text)) {
		const trimmed = segment.trim();
		if (!trimmed) continue;
		const start = index + (segment.length - segment.trimStart().length);
		sentences.push({text: trimmed, start, end: start + trimmed.length});
	}
	return sentences;
}

function packAtoms(atoms: Atom[], budget: number, minTokens: number): Atom[][] {
	const n = atoms.length;
	if (n === 0) return [];

	const prefix = new Array<number>(n + 1).fill(0);
	for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + atoms[i].tokens;

	const slackCeiling = budget * budget;
	const SUBMIN_PENALTY = (n + 1) * slackCeiling + 1;
	const OVERFLOW_PENALTY = (n + 1) * SUBMIN_PENALTY + 1;

	const cost = (from: number, to: number): number => {
		const size = prefix[to + 1] - prefix[from];
		if (size > budget) return OVERFLOW_PENALTY + (size - budget) ** 2;
		if (size < minTokens) return SUBMIN_PENALTY + (minTokens - size) ** 2;
		return (budget - size) ** 2;
	};

	const best = new Array<number>(n + 1).fill(0);
	const breakAt = new Array<number>(n).fill(0);

	for (let from = n - 1; from >= 0; from--) {
		let bestCost = Infinity;
		let bestEnd = from;
		for (let to = from; to < n; to++) {
			if (prefix[to + 1] - prefix[from] > budget && to > from) break;
			const candidate = cost(from, to) + best[to + 1];
			if (candidate < bestCost) {
				bestCost = candidate;
				bestEnd = to;
			}
		}
		best[from] = bestCost;
		breakAt[from] = bestEnd;
	}

	const runs: Atom[][] = [];
	for (let from = 0; from < n;) {
		const to = breakAt[from];
		runs.push(atoms.slice(from, to + 1));
		from = to + 1;
	}
	return runs;
}

function splitOversizedSentence(
	sentence: Atom,
	source: string,
	countTokens: TokenCounter,
	budget: number
): Atom[] {
	const words: Atom[] = [];
	for (const match of sentence.text.matchAll(/\S+/g)) {
		const start = sentence.start + (match.index ?? 0);
		words.push({
			text: match[0],
			start,
			end: start + match[0].length,
			tokens: countTokens(match[0]),
		});
	}
	if (words.length <= 1) return [sentence];

	return packAtoms(words, budget, 0).map((run) => {
		const start = run[0].start;
		const end = run[run.length - 1].end;
		const text = source.slice(start, end);
		// Recount on the joined slice: subword tokenizers aren't additive, so the
		// sum of per-word counts is only an estimate. A piece can still land over
		// budget here, in which case the caller's tokenizer truncates it.
		return {text, start, end, tokens: countTokens(text)};
	});
}

export function chunkText(
	text: string,
	countTokens: TokenCounter,
	chunkTokenBudget: number,
	maxOverlapPercent = 0,
	minChunkTokens = 0
): TextChunk[] {
	const clampedPercent = Math.max(0, Math.min(maxOverlapPercent, MAX_OVERLAP_PERCENT));
	const overlapBudget = Math.floor((chunkTokenBudget * clampedPercent) / 100);
	const contentBudget = Math.max(1, chunkTokenBudget - overlapBudget);
	const minTokens = Math.max(0, Math.min(minChunkTokens, contentBudget));

	const atoms: Atom[] = [];
	for (const sentence of segmentSentences(text)) {
		const tokens = countTokens(sentence.text);
		if (tokens <= contentBudget) {
			atoms.push({...sentence, tokens});
		} else {
			atoms.push(
				...splitOversizedSentence({...sentence, tokens}, text, countTokens, contentBudget)
			);
		}
	}
	if (atoms.length === 0) return [];

	const runs = packAtoms(atoms, contentBudget, minTokens);

	const carryOverlap = (previous: Atom[]): Atom[] => {
		if (overlapBudget <= 0) return [];
		const carried: Atom[] = [];
		let carriedTokens = 0;
		for (let i = previous.length - 1; i >= 0; i--) {
			if (carriedTokens + previous[i].tokens > overlapBudget) break;
			carried.unshift(previous[i]);
			carriedTokens += previous[i].tokens;
		}
		return carried;
	};

	return runs.map((canonical, index) => {
		const embedded = index === 0 ? canonical : [...carryOverlap(runs[index - 1]), ...canonical];
		const chunkText = embedded.map((atom) => atom.text).join(' ');
		return {
			text: chunkText,
			start: embedded[0].start,
			end: embedded[embedded.length - 1].end,
			canonicalStart: canonical[0].start,
			canonicalEnd: canonical[canonical.length - 1].end,
			tokens: countTokens(chunkText),
		};
	});
}

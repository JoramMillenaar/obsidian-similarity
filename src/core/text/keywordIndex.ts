/**
 * Keyword index for search-bar queries: BM25 over whole notes, used only to lift notes that contain
 * (nearly) every distinctive word of a search above the meaning-based ranking. Dense search misses
 * names, rare words and codes ("PASMO", "Zahnriemen", "GPIO 18"); this catches them without
 * reordering anything else.
 *
 * No stemming or stop words, since vaults mix languages. Instead:
 *  - a query word of 4+ letters also matches index words it is a prefix of, up to 3 letters longer
 *    ("altbau" → "altbaus", "hike" → "hiked"), counted as one term;
 *  - Han, kana and Hangul runs have no spaces, so they are indexed as overlapping character bigrams;
 *  - number sequences ("4-7-8", "12:30", "2024-01-05") are kept whole, next to their parts.
 */

const CJK_CLASS = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}";
const CJK = new RegExp(`[${CJK_CLASS}]`, "u");
const CJK_SPLIT = new RegExp(`[${CJK_CLASS}]+|[^${CJK_CLASS}]+`, "gu");
const NUMBER_SEQUENCE = /\d+(?:[-./:]\d+)+/g;

const MIN_PREFIX = 4;
const MAX_SUFFIX = 3;

const K1 = 1.2;
const B = 0.75;

export type KeywordSearchOptions = {
	/** How many of the best BM25 hits may qualify. */
	top?: number;
	/** Share of the query's (IDF-weighted) distinctive words a note must contain. */
	minCoverage?: number;
	/** Words found in more than this share of notes ("the", "how") count neither for nor against a note. */
	commonShare?: number;
};

const DEFAULTS: Required<KeywordSearchOptions> = {top: 3, minCoverage: 0.8, commonShare: 0.05};

const fold = (word: string) => word.normalize("NFD").replace(/\p{M}+/gu, "");

export function tokenize(text: string): string[] {
	const normalized = text.normalize("NFKC").toLowerCase();
	const out: string[] = normalized.match(NUMBER_SEQUENCE) ?? [];
	for (const word of normalized.match(/[\p{L}\p{N}]+/gu) ?? []) {
		if (!CJK.test(word)) {
			// Accents fold away (é → e, ä → a), so "Matatlan" finds "Matatlán".
			out.push(fold(word));
			continue;
		}
		// Mixed runs ("gpio18号") split into CJK and non-CJK parts.
		for (const part of word.match(CJK_SPLIT) ?? []) {
			if (!CJK.test(part)) {
				out.push(fold(part));
			} else if (part.length === 1) {
				out.push(part);
			} else {
				for (let i = 0; i + 1 < part.length; i++) out.push(part.slice(i, i + 2));
			}
		}
	}
	return out;
}

/** Whether a query token also matches longer index words: plain words of 4+ letters only. */
const expandable = (token: string) => token.length >= MIN_PREFIX && /^\p{L}+$/u.test(token) && !CJK.test(token);

/** Whether index word `word` counts as query token `token`. */
function matches(token: string, word: string): boolean {
	if (word === token) return true;
	return expandable(token) && word.startsWith(token) && word.length - token.length <= MAX_SUFFIX;
}

/** How many of the query's distinct tokens occur in `text`; picks the passage a keyword match shows. */
export function countQueryTerms(query: string, text: string): number {
	const words = new Set(tokenize(text));
	let count = 0;
	for (const token of new Set(tokenize(query))) {
		if (words.has(token)) {
			count++;
			continue;
		}
		for (const word of words) {
			if (matches(token, word)) {
				count++;
				break;
			}
		}
	}
	return count;
}

type Doc = { hash: string; terms: Map<string, number>; length: number };

export class KeywordIndex {
	private readonly docs = new Map<string, Doc>();
	private readonly postings = new Map<string, Map<string, number>>();
	private totalLength = 0;
	private sortedTerms: string[] | null = null;
	private readonly expanded = new Map<string, Map<string, number>>();

	get size(): number {
		return this.docs.size;
	}

	ids(): string[] {
		return [...this.docs.keys()];
	}

	/** The content hash `id` was indexed under, so callers can skip unchanged notes. */
	hashOf(id: string): string | undefined {
		return this.docs.get(id)?.hash;
	}

	set(id: string, text: string, hash: string): void {
		this.remove(id);
		const tokens = tokenize(text);
		const terms = new Map<string, number>();
		for (const token of tokens) terms.set(token, (terms.get(token) ?? 0) + 1);
		for (const [term, tf] of terms) {
			let list = this.postings.get(term);
			if (!list) this.postings.set(term, (list = new Map()));
			list.set(id, tf);
		}
		this.docs.set(id, {hash, terms, length: tokens.length});
		this.totalLength += tokens.length;
		this.changed();
	}

	remove(id: string): boolean {
		const doc = this.docs.get(id);
		if (!doc) return false;
		for (const term of doc.terms.keys()) {
			const list = this.postings.get(term);
			list?.delete(id);
			if (list?.size === 0) this.postings.delete(term);
		}
		this.docs.delete(id);
		this.totalLength -= doc.length;
		this.changed();
		return true;
	}

	clear(): void {
		this.docs.clear();
		this.postings.clear();
		this.totalLength = 0;
		this.changed();
	}

	/**
	 * Notes that contain nearly every distinctive word of `query`: among the `top` best BM25 hits,
	 * those whose coverage of the query's words reaches `minCoverage`, best first. Usually empty for
	 * a descriptive search, which is what keeps the meaning-based ranking in charge.
	 */
	search(query: string, options: KeywordSearchOptions = {}): string[] {
		const {top, minCoverage, commonShare} = {...DEFAULTS, ...options};
		const n = this.docs.size;
		if (n === 0) return [];

		const avgLength = this.totalLength / n;
		const scores = new Map<string, number>();
		const covered = new Map<string, number>();
		let coverageTotal = 0;

		const tokens = tokenize(query);
		for (const token of new Set(tokens)) {
			const list = this.postingsFor(token);
			const df = list?.size ?? 0;
			const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
			// A word in no note at all still counts against coverage: a search in another language
			// than the notes then rarely qualifies, and dense search keeps those.
			const counts = df <= commonShare * n;
			if (counts) coverageTotal += idf;
			if (!list) continue;

			const repeats = tokens.filter((t) => t === token).length;
			for (const [id, tf] of list) {
				const norm = K1 * (1 - B + B * this.docs.get(id)!.length / avgLength);
				scores.set(id, (scores.get(id) ?? 0) + repeats * idf * tf * (K1 + 1) / (tf + norm));
				if (counts) covered.set(id, (covered.get(id) ?? 0) + idf);
			}
		}
		if (coverageTotal === 0) return [];

		return [...scores]
			.sort((a, b) => b[1] - a[1])
			.slice(0, top)
			.filter(([id]) => (covered.get(id) ?? 0) / coverageTotal >= minCoverage)
			.map(([id]) => id);
	}

	/** A query token's postings: the exact term plus, for plain words, its longer forms, merged per note. */
	private postingsFor(token: string): Map<string, number> | undefined {
		if (!expandable(token)) return this.postings.get(token);
		const cached = this.expanded.get(token);
		if (cached) return cached.size ? cached : undefined;

		const terms = (this.sortedTerms ??= [...this.postings.keys()].sort());
		let lo = 0;
		let hi = terms.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (terms[mid] < token) lo = mid + 1;
			else hi = mid;
		}
		const merged = new Map<string, number>();
		for (let i = lo; i < terms.length && terms[i].startsWith(token); i++) {
			if (!matches(token, terms[i])) continue;
			for (const [id, tf] of this.postings.get(terms[i])!) merged.set(id, (merged.get(id) ?? 0) + tf);
		}
		this.expanded.set(token, merged);
		return merged.size ? merged : undefined;
	}

	private changed(): void {
		this.sortedTerms = null;
		this.expanded.clear();
	}
}

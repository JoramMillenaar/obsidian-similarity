export const MAX_OVERLAP_PERCENT = 50;

export interface Sentence {
	text: string;
	start: number;
	end: number;
}

interface TokenizedSentence extends Sentence {
	tokens: number;
}

export interface TextChunk {
	text: string;
	start: number;
	end: number;
}

/** A capability the domain needs but doesn't own: turning text into a token count. */
export type TokenCounter = (text: string) => number;

// Yields each sentence with its span in `text`. Offsets are of the TRIMMED
// sentence, so a chunk's [start, end) maps back onto the caller's own string.
const sentenceSegmenter = new Intl.Segmenter('und', { granularity: 'sentence' });

export function segmentSentences(text: string): Sentence[] {
	const sentences: Sentence[] = [];
	for (const { segment, index } of sentenceSegmenter.segment(text)) {
		const trimmed = segment.trim();
		if (!trimmed) continue;
		const start = index + (segment.length - segment.trimStart().length);
		sentences.push({ text: trimmed, start, end: start + trimmed.length });
	}
	return sentences;
}

function sumTokens(sentences: TokenizedSentence[]): number {
	return sentences.reduce((total, sentence) => total + sentence.tokens, 0);
}

/**
 * Splits `text` into token-budgeted chunks, carrying a trailing-sentence
 * overlap forward into the next chunk. `countTokens` is injected so this
 * stays a pure transformation over plain data — the caller owns the
 * tokenizer/model that gives token counts their meaning.
 */
export function chunkText(
	text: string,
	countTokens: TokenCounter,
	chunkTokenBudget: number,
	maxOverlapPercent = 0
): TextChunk[] {
	const clampedPercent = Math.max(0, Math.min(maxOverlapPercent, MAX_OVERLAP_PERCENT));
	const overlapBudget = Math.floor((chunkTokenBudget * clampedPercent) / 100);

	const sentences: TokenizedSentence[] = segmentSentences(text)
		.map((sentence) => ({ ...sentence, tokens: countTokens(sentence.text) }));
	if (sentences.length === 0) return [];

	const chunks: TextChunk[] = [];
	let current: TokenizedSentence[] = [];
	let currentTokens = 0;

	// A chunk spans from its first sentence's start to its last one's end.
	const flush = () => {
		if (current.length === 0) return;
		chunks.push({
			text: current.map((sentence) => sentence.text).join(' '),
			start: current[0].start,
			end: current[current.length - 1].end,
		});
	};

	const overlapSeed = (): TokenizedSentence[] => {
		if (overlapBudget <= 0) return [];
		const seed: TokenizedSentence[] = [];
		let seedTokens = 0;
		for (let i = current.length - 1; i >= 0; i--) {
			if (seedTokens + current[i].tokens > overlapBudget) break;
			seed.unshift(current[i]);
			seedTokens += current[i].tokens;
		}
		return seed;
	};

	for (const sentence of sentences) {
		// A lone sentence over budget can't be packed with anything; give it
		// its own chunk and let the caller's tokenizer truncate it.
		if (sentence.tokens >= chunkTokenBudget) {
			flush();
			chunks.push({ text: sentence.text, start: sentence.start, end: sentence.end });
			current = [];
			currentTokens = 0;
			continue;
		}

		if (currentTokens + sentence.tokens > chunkTokenBudget && current.length > 0) {
			flush();
			current = overlapSeed();
			currentTokens = sumTokens(current);
			// Trim overlap until the incoming sentence fits the budget.
			while (current.length > 0 && currentTokens + sentence.tokens > chunkTokenBudget) {
				currentTokens -= current[0].tokens;
				current.shift();
			}
		}

		current.push(sentence);
		currentTokens += sentence.tokens;
	}

	flush();
	return chunks;
}

export type TextSpan = { start: number; end: number };

/**
 * The stretch of a note's text around `passage` that fits in `maxChars`, grown a whole span at a
 * time, after then before, so the passage is read with its context. `spans` are the note's indexed
 * passages in text order; `passage` should be one of them, else it is returned alone (cut to fit).
 */
export function passageWindow(spans: readonly TextSpan[], passage: TextSpan, maxChars: number): TextSpan {
	let start = passage.start;
	let end = Math.min(passage.end, passage.start + maxChars);
	let lo = spans.findIndex((span) => span.start === passage.start && span.end === passage.end);
	if (lo < 0) return {start, end};

	let hi = lo;
	for (let grew = true; grew;) {
		grew = false;
		if (hi + 1 < spans.length && spans[hi + 1].end - start <= maxChars) {
			end = spans[++hi].end;
			grew = true;
		}
		if (lo > 0 && end - spans[lo - 1].start <= maxChars) {
			start = spans[--lo].start;
			grew = true;
		}
	}
	return {start, end};
}

/**
 * Splits `window` into pieces of whole consecutive spans, each up to `maxChars` long unless a single
 * span is longer, in text order. A span reaching past the window is cut at its edge.
 */
export function splitWindow(spans: readonly TextSpan[], window: TextSpan, maxChars: number): TextSpan[] {
	const pieces: TextSpan[] = [];
	for (const span of spans) {
		if (span.end <= window.start || span.start >= window.end) continue;
		const start = Math.max(span.start, window.start);
		const end = Math.min(span.end, window.end);
		const last = pieces[pieces.length - 1];
		if (last && end - last.start <= maxChars) last.end = end;
		else pieces.push({start, end});
	}
	return pieces;
}

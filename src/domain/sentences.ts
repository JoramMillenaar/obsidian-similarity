/**
 * Sentence segmentation for the host. The embedder does its own segmentation
 * inside the iframe because chunking needs the model's token count; this copy
 * needs no model at all, only Intl, so the centroid search can split and quote
 * text without a round trip.
 */
const sentenceSegmenter = new Intl.Segmenter("und", {granularity: "sentence"});

export function segmentSentences(text: string): string[] {
	const sentences: string[] = [];

	for (const {segment} of sentenceSegmenter.segment(text)) {
		const trimmed = segment.trim();
		if (trimmed) sentences.push(trimmed);
	}

	return sentences;
}

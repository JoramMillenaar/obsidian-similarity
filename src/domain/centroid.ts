import { NoteChunk } from "../types";
import { averageEmbeddings, cosineSimilarity, normalizeEmbedding } from "./embedding";
import { segmentSentences } from "./sentences";

export type EmbedOneText = (text: string) => Promise<number[] | null>;

/**
 * Finds the passage that best represents a note as a whole, to show as its
 * description.
 *
 * The note's "average meaning" is the mean of every chunk embedding. A binary
 * search then homes in on it: start from the chunk nearest that mean, split it
 * at its sentence midpoint, keep whichever half is nearer, and repeat. Each
 * step halves the text, so the surviving section converges on the part of the
 * note that carries its central idea rather than merely its opening — and, at
 * the default depth, shrinks to a sentence or two, which is the description.
 *
 * Splits only ever fall on sentence boundaries, so the result is quotable as
 * written and never cuts a sentence in half.
 */
export async function findCentroidText(args: {
	preparedText: string;
	chunks: NoteChunk[];
	/** Binary-search steps. Each one halves the section and costs two embeddings. */
	steps: number;
	embedOne: EmbedOneText;
}): Promise<string | null> {
	const target = averageMeaning(args.chunks);
	if (!target) return null;

	const nearest = nearestChunk(args.chunks, target);
	if (!nearest) return null;

	let section = segmentSentences(args.preparedText.slice(nearest.start, nearest.end));
	if (section.length === 0) return null;

	for (let step = 0; step < args.steps; step++) {
		// A single sentence has no midpoint to split on — this is where an
		// oversized-sentence chunk bottoms out.
		if (section.length < 2) break;

		const next = await narrowToNearerHalf(section, target, args.embedOne);
		if (!next) break;
		section = next;
	}

	return section.length > 0 ? section.join(" ") : null;
}

/** The mean of every chunk, renormalized so it can be compared by cosine like any other unit vector. */
function averageMeaning(chunks: NoteChunk[]): number[] | null {
	const mean = averageEmbeddings(chunks.map((chunk) => chunk.embedding));
	return mean ? normalizeEmbedding(mean) : null;
}

function nearestChunk(chunks: NoteChunk[], target: number[]): NoteChunk | null {
	let best: NoteChunk | null = null;
	let bestScore = -Infinity;

	for (const chunk of chunks) {
		const score = cosineSimilarity(chunk.embedding, target);
		if (score > bestScore) {
			bestScore = score;
			best = chunk;
		}
	}

	return best;
}

/** Splits at the sentence midpoint and returns whichever half sits nearer the target. */
async function narrowToNearerHalf(
	section: string[],
	target: number[],
	embedOne: EmbedOneText,
): Promise<string[] | null> {
	const mid = Math.ceil(section.length / 2);
	const left = section.slice(0, mid);
	const right = section.slice(mid);

	const leftEmbedding = await embedOne(left.join(" "));
	const rightEmbedding = await embedOne(right.join(" "));

	// If only one half could be embedded, it's still a strictly better answer
	// than the section we started from; if neither, the caller keeps the current.
	if (!leftEmbedding) return rightEmbedding ? right : null;
	if (!rightEmbedding) return left;

	return cosineSimilarity(leftEmbedding, target) >= cosineSimilarity(rightEmbedding, target)
		? left
		: right;
}

import { RelatedNote, RerankerModelConfig } from "../types";
import { Device } from "../ports";
import { GetNoteTextUseCase } from "../app/getNoteText";
import { IndexHandle } from "../indexing/store/indexHandle";
import { passageWindow, splitWindow, TextSpan } from "../core/text/passageWindow";
import { hashText } from "../core/text/hash";

/**
 * Reorders a text search's results by how relevant the cross-encoder judges each note to the search.
 * It reads the stretch around the note's matched passage in pieces, each with the note's title, and
 * the best piece ranks the note and becomes its `passage` (and `passageText`). Only the first
 * candidates are judged (fewer on the CPU); those it finds irrelevant are dropped. Each result
 * carries its `relevance`.
 */
export type RerankResultsUseCase = (query: string, items: RelatedNote[], signal?: AbortSignal) => Promise<RelatedNote[]>;

type Candidate = {
	item: RelatedNote;
	text: string;
	/** The note's title line, which the prepared text starts with. */
	title: string;
	pieces: TextSpan[];
};

export function makeRerankResults(deps: {
	getIndex: () => IndexHandle | null;
	getNoteText: GetNoteTextUseCase;
	score: (query: string, passages: string[], signal?: AbortSignal) => Promise<number[]>;
	/** Where the reranker runs, or null while that isn't known yet (it is still loading). */
	device: () => Device | null;
	config: Pick<RerankerModelConfig, "candidates" | "cpuCandidates" | "passageChars" | "pieceChars" | "minRelevance">;
}): RerankResultsUseCase {
	const {candidates, cpuCandidates, passageChars, pieceChars, minRelevance} = deps.config;

	async function read(item: RelatedNote, index: IndexHandle | null): Promise<Candidate> {
		const {text} = await deps.getNoteText(item.id);
		const title = text.slice(0, text.indexOf("\n") + 1);
		const spans = index?.get(item.id)?.chunks ?? [];
		if (!spans.length) return {item, text, title, pieces: [{start: 0, end: Math.min(text.length, passageChars)}]};

		const window = passageWindow(spans, item.passage ?? spans[0], passageChars);
		const pieces = splitWindow(spans, window, pieceChars);
		return {item, text, title, pieces: pieces.length ? pieces : [window]};
	}

	/** What the reranker reads for a piece: the note's title, then the piece. */
	function pairText({text, title}: Candidate, piece: TextSpan): string {
		return piece.start < title.length ? text.slice(0, piece.end) : title + text.slice(piece.start, piece.end);
	}

	return async function rerankResults(query, items, signal) {
		const index = deps.getIndex();
		const limit = deps.device() === "webgpu" ? candidates : cpuCandidates;
		const notes = await Promise.all(items.slice(0, limit).map((item) => read(item, index).catch(() => null)));
		const pairs = notes.flatMap((candidate) => candidate
			? candidate.pieces
				.filter((piece) => candidate.text.slice(piece.start, piece.end).trim())
				.map((piece) => ({candidate, piece}))
			: []);
		const scores = await deps.score(query, pairs.map(({candidate, piece}) => pairText(candidate, piece)), signal);

		const best = new Map<Candidate, { piece: TextSpan; relevance: number }>();
		pairs.forEach(({candidate, piece}, i) => {
			const current = best.get(candidate);
			if (!current || scores[i] > current.relevance) best.set(candidate, {piece, relevance: scores[i]});
		});

		const reranked: (RelatedNote & { relevance: number })[] = [];
		for (const [{item, text, title}, {piece: {start, end}, relevance}] of best) {
			if (relevance < minRelevance) continue;
			reranked.push({
				...item,
				relevance,
				passage: {start, end, hash: hashText(text.slice(start, end))},
				passageText: text.slice(Math.max(start, title.length), end),
			});
		}
		return reranked.sort((a, b) => b.relevance - a.relevance);
	};
}

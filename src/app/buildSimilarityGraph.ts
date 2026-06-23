import { SimilarityGraph } from "../types";
import { IndexRepository } from "../ports";
import { cosineSimilarity } from "../domain/embedding";

export type BuildSimilarityGraphUseCase = (args: {
	/** Number of most-similar neighbours to connect to each node (N). */
	linksPerNode: number;
	/** Minimum cosine similarity required for an edge. */
	minScore?: number;
}) => Promise<SimilarityGraph>;

type ScoredNeighbour = { id: string; score: number };

/**
 * Assembles the semantic similarity graph for the whole index.
 *
 * This is orchestration only: it reads the index through {@link IndexRepository}
 * and reuses the existing domain similarity math ({@link cosineSimilarity}). No
 * new scoring rules live here. Directional top-N relationships are collapsed into
 * undirected, de-duplicated edges whose weight is the strongest of the two
 * directions, and node degree is the number of distinct neighbours.
 */
export function makeBuildSimilarityGraph(deps: {
	indexRepo: IndexRepository;
}): BuildSimilarityGraphUseCase {
	return async function buildSimilarityGraph({linksPerNode, minScore = 0}): Promise<SimilarityGraph> {
		const limit = Math.max(0, Math.floor(linksPerNode));
		const indexed = await deps.indexRepo.listAll();

		const nodeIds = indexed.map((note) => note.id);
		const degrees = new Map<string, number>(nodeIds.map((id) => [id, 0]));

		if (limit === 0 || indexed.length < 2) {
			return {
				nodes: nodeIds.map((id) => ({id, degree: 0})),
				edges: [],
			};
		}

		// Undirected edge key -> edge with the best score seen in either direction.
		// Note ids are vault paths (which may contain spaces); use newline as a
		// separator since paths cannot contain one.
		const edges = new Map<string, { source: string; target: string; score: number }>();

		for (let i = 0; i < indexed.length; i++) {
			const source = indexed[i];
			const neighbours: ScoredNeighbour[] = [];

			for (let j = 0; j < indexed.length; j++) {
				if (i === j) continue;
				const score = cosineSimilarity(source.embedding, indexed[j].embedding);
				if (Number.isFinite(score) && score >= minScore) {
					neighbours.push({id: indexed[j].id, score});
				}
			}

			neighbours.sort((a, b) => b.score - a.score);

			for (const neighbour of neighbours.slice(0, limit)) {
				const [a, b] = source.id < neighbour.id
					? [source.id, neighbour.id]
					: [neighbour.id, source.id];
				const key = `${a}\n${b}`;
				const existing = edges.get(key);
				if (existing === undefined) {
					edges.set(key, {source: a, target: b, score: neighbour.score});
					degrees.set(a, (degrees.get(a) ?? 0) + 1);
					degrees.set(b, (degrees.get(b) ?? 0) + 1);
				} else if (neighbour.score > existing.score) {
					existing.score = neighbour.score;
				}
			}
		}

		return {
			nodes: nodeIds.map((id) => ({id, degree: degrees.get(id) ?? 0})),
			edges: Array.from(edges.values()),
		};
	};
}

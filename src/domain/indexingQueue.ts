import { NoteIndexCandidate } from "../types";

export type IndexQueue = string[];

export function createEmptyIndexQueue(): IndexQueue {
	return [];
}

export function sortInitialIndexCandidates(candidates: NoteIndexCandidate[]): string[] {
	return [...candidates]
		.sort((left, right) => {
			const leftRank = left.recentOpenRank ?? Number.POSITIVE_INFINITY;
			const rightRank = right.recentOpenRank ?? Number.POSITIVE_INFINITY;

			if (leftRank !== rightRank) {
				return leftRank - rightRank;
			}
			if (left.modifiedAt !== right.modifiedAt) {
				return right.modifiedAt - left.modifiedAt;
			}
			return left.id.localeCompare(right.id);
		})
		.map((candidate) => candidate.id);
}

export function mergeSeedQueue(queue: IndexQueue, seedIds: string[]): IndexQueue {
	const existing = new Set(queue);
	const additions = seedIds.filter((id, index) => !existing.has(id) && seedIds.indexOf(id) === index);
	return [...queue, ...additions];
}

export function bumpQueuedNote(queue: IndexQueue, noteId: string): IndexQueue {
	return [noteId, ...queue.filter((id) => id !== noteId)];
}

export function removeQueuedNotes(queue: IndexQueue, noteIds: string[]): IndexQueue {
	if (noteIds.length === 0) {
		return queue;
	}

	const removed = new Set(noteIds);
	return queue.filter((id) => !removed.has(id));
}

export function dequeueNextQueuedNote(queue: IndexQueue): {
	noteId: string;
	queue: IndexQueue;
} | null {
	const [noteId, ...rest] = queue;
	if (!noteId) {
		return null;
	}

	return {noteId, queue: rest};
}

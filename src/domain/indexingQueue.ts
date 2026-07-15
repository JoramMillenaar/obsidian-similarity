import { IndexingBannerState, IndexingPriorityReason, IndexingQueueSnapshot, NoteIndexCandidate, } from "../types";

export type IndexQueueBuckets = {
	manual: string[];
	edit: string[];
	open: string[];
	seed: string[];
};

const BUCKET_BY_REASON: Record<IndexingPriorityReason, keyof IndexQueueBuckets> = {
	manual: "manual",
	edit: "edit",
	open: "open",
	seed: "seed",
};

export function createEmptyIndexQueue(): IndexQueueBuckets {
	return {
		manual: [],
		edit: [],
		open: [],
		seed: [],
	};
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

export function mergeSeedQueue(
	queue: IndexQueueBuckets,
	seedIds: string[],
): IndexQueueBuckets {
	const blocked = new Set([
		...queue.manual,
		...queue.edit,
		...queue.open,
	]);

	return {
		...queue,
		seed: seedIds.filter((id, index) => !blocked.has(id) && seedIds.indexOf(id) === index),
	};
}

export function bumpQueuedNote(
	queue: IndexQueueBuckets,
	noteId: string,
	reason: IndexingPriorityReason,
): IndexQueueBuckets {
	const next = removeQueuedNotes(queue, [noteId]);
	const bucket = BUCKET_BY_REASON[reason];
	return {
		...next,
		[bucket]: [noteId, ...next[bucket]],
	};
}

export function removeQueuedNotes(
	queue: IndexQueueBuckets,
	noteIds: string[],
): IndexQueueBuckets {
	if (noteIds.length === 0) {
		return queue;
	}

	const removed = new Set(noteIds);
	return {
		manual: queue.manual.filter((id) => !removed.has(id)),
		edit: queue.edit.filter((id) => !removed.has(id)),
		open: queue.open.filter((id) => !removed.has(id)),
		seed: queue.seed.filter((id) => !removed.has(id)),
	};
}

export function dequeueNextQueuedNote(queue: IndexQueueBuckets): {
	noteId: string;
	queue: IndexQueueBuckets;
} | null {
	for (const bucket of ["manual", "edit", "open", "seed"] as const) {
		const [noteId, ...rest] = queue[bucket];
		if (!noteId) {
			continue;
		}

		return {
			noteId,
			queue: {
				...queue,
				[bucket]: rest,
			},
		};
	}

	return null;
}

export function hasQueuedNote(queue: IndexQueueBuckets, noteId: string): boolean {
	return queue.manual.includes(noteId)
		|| queue.edit.includes(noteId)
		|| queue.open.includes(noteId)
		|| queue.seed.includes(noteId);
}

export function countQueuedNotes(queue: IndexQueueBuckets): number {
	return queue.manual.length + queue.edit.length + queue.open.length + queue.seed.length;
}

export function getIndexingBannerState(
	snapshot: Omit<IndexingQueueSnapshot, "banner">,
): IndexingBannerState {
	const processed = snapshot.processed;
	const total = snapshot.total;
	const progressLabel = total > 0
		? `${processed} / ${total}`
		: undefined;

	if (snapshot.fatalError) {
		return {
			kind: "failed",
			message: snapshot.hasCompletedInitialIndex
				? "Index updates paused after an error. Results may be stale until you sync again."
				: "Indexing paused after an error. Results may be incomplete until you sync again.",
			progressLabel,
			processed,
			total,
		};
	}

	// Summarizing only ever runs once the note queue has drained, so it can't
	// mask indexing progress by taking precedence here.
	if (snapshot.phase === "summarizing") {
		return {
			kind: "summarizing",
			message: "Generating note descriptions. Related notes are already available.",
			progressLabel,
			processed,
			total,
		};
	}

	if (snapshot.isRunning || snapshot.pending > 0) {
		return {
			kind: snapshot.hasCompletedInitialIndex ? "updating" : "initial",
			message: snapshot.hasCompletedInitialIndex
				? "Index update in progress. Results may shift as more notes are processed."
				: "Initial indexing in progress. Results are already available, but they may still be incomplete.",
			progressLabel,
			processed,
			total,
		};
	}

	return {
		kind: "hidden",
		message: "",
		progressLabel,
		processed,
		total,
	};
}

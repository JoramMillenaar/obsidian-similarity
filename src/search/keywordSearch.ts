import { PassageSpan } from "../types";
import { GetNoteTextUseCase } from "../app/getNoteText";
import { IndexHandle } from "../indexing/store/indexHandle";
import { countQueryTerms, KeywordIndex } from "../core/text/keywordIndex";

/** A note a search's words were found in, with the indexed passage that holds the most of them. */
export type KeywordHit = { id: string; passage?: PassageSpan };

export interface KeywordSearch {
	/** Brings the keyword index up to date in the background, e.g. when the search opens. */
	prepare(): void;
	find(query: string): Promise<KeywordHit[]>;
}

const YIELD_EVERY = 50;

/**
 * Keeps an in-memory {@link KeywordIndex} in step with the embedding index: the same notes, re-read
 * only when their content hash changed. It indexes raw markdown (`readMarkdown`), not the prepared
 * text: extracting text costs ~10 ms a note, which would make building it take half a minute, and
 * keywords don't need it (frontmatter tags and aliases are even worth matching). It isn't persisted;
 * the first search after startup reads every note once, which {@link KeywordSearch.prepare} starts early.
 * The prepared text is read only to pick the passage of the few notes found.
 */
export function makeKeywordSearch(deps: {
	getIndex: () => IndexHandle | null;
	/** A note's title and markdown, under the same character cap as indexing. */
	readMarkdown: (noteId: string) => Promise<string>;
	getNoteText: GetNoteTextUseCase;
}): KeywordSearch {
	const keywords = new KeywordIndex();
	let indexed: IndexHandle | null = null;
	let syncing: Promise<void> | null = null;

	async function sync(handle: IndexHandle): Promise<void> {
		// Another model's index may hold other notes (ignored paths, failures): start over.
		if (handle !== indexed) {
			keywords.clear();
			indexed = handle;
		}

		const entries = handle.entries();
		const live = new Set(entries.map((entry) => entry.id));
		for (const id of keywords.ids()) {
			if (!live.has(id)) keywords.remove(id);
		}

		let read = 0;
		for (const {id, contentHash} of entries) {
			if (keywords.hashOf(id) === contentHash) continue;
			try {
				keywords.set(id, await deps.readMarkdown(id), contentHash);
			} catch {
				keywords.remove(id);
			}
			if (++read % YIELD_EVERY === 0) await new Promise((resolve) => window.setTimeout(resolve, 0));
		}
	}

	function synced(): Promise<void> {
		const handle = deps.getIndex();
		if (!handle) return Promise.resolve();
		syncing ??= sync(handle).finally(() => {
			syncing = null;
		});
		return syncing;
	}

	async function passageOf(handle: IndexHandle, id: string, query: string): Promise<PassageSpan | undefined> {
		const chunks = handle.get(id)?.chunks;
		if (!chunks?.length) return undefined;
		const {text} = await deps.getNoteText(id);
		let best = chunks[0];
		let bestCount = -1;
		for (const chunk of chunks) {
			const count = countQueryTerms(query, text.slice(chunk.start, chunk.end));
			if (count > bestCount) [best, bestCount] = [chunk, count];
		}
		return {start: best.start, end: best.end, hash: best.hash};
	}

	return {
		prepare() {
			void synced().catch((error) => console.error("[Similarity] Failed to build the keyword index:", error));
		},

		async find(query) {
			await synced();
			const handle = deps.getIndex();
			if (!handle || handle !== indexed) return [];

			const hits: KeywordHit[] = [];
			for (const id of keywords.search(query)) {
				const passage = await passageOf(handle, id, query).catch(() => undefined);
				hits.push({id, passage});
			}
			return hits;
		},
	};
}

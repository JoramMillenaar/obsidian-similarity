import { IndexedNote } from "../types";
import { IndexUnusableReason } from "../domain/indexHealth";

export type IndexRepairOutcome = {
	/** True when the index is now empty but shouldn't be — the caller must force a full reindex. */
	rebuildRequired: boolean;
	/** Ids of entries dropped as damaged. The normal sync plan re-indexes these. */
	droppedIds: string[];
	/** Set only when the whole index was discarded. */
	discardedReason?: IndexUnusableReason;
};

export interface IndexStorage {
	getAll(): Promise<IndexedNote[]>;

	rewrite(index: IndexedNote[]): Promise<void>;

	/** Forces any throttled/pending rewrite to hit disk immediately. No-op if nothing is pending. */
	flush(): Promise<void>;

	isEmpty(): Promise<boolean>;

	/**
	 * Verifies the persisted index and heals it in place: drops damaged entries,
	 * or discards everything if the fault is index-wide. Idempotent — a second
	 * run over a healthy index changes nothing.
	 */
	repair(): Promise<IndexRepairOutcome>;
}

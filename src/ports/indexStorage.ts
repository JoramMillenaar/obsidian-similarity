import { IndexedNote } from "../types";

export interface IndexStorage {
	getAll(): Promise<IndexedNote[]>;

	rewrite(index: IndexedNote[]): Promise<void>;

	isEmpty(): Promise<boolean>;

	/** True if the persisted index references embeddings the binary sidecar can no longer supply (missing/corrupt/dim mismatch). */
	needsRebuild(): Promise<boolean>;

	/** One-time read of the pre-migration shape (inline float64 embeddings). Returns null once already migrated. */
	readLegacy(): Promise<IndexedNote[] | null>;
}

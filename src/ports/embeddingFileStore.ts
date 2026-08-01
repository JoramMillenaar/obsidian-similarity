/**
 * Read/write access to the raw embeddings binary sidecar (embeddings.bin).
 * Works purely in ArrayBuffer terms so the storage adapter stays free of
 * Obsidian's vault API and its migration path is unit-testable in memory.
 */
export interface EmbeddingFileStore {
	/** Returns the sidecar bytes, or null when the file does not exist. */
	read(): Promise<ArrayBuffer | null>;

	write(buffer: ArrayBuffer): Promise<void>;
}

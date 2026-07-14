const {normalizePluginData} = require("../../dist/domain/normalize.js");

/**
 * In-memory stand-in for ObsidianPluginDataStore. Mirrors it exactly: holds a
 * raw data blob and runs every read through the REAL normalizePluginData, so
 * read-time normalization stays under test. `write`/`update` mutate the blob.
 *
 * Seed with the raw contents of a fixture's data.json (as it sat on disk).
 */
class InMemoryPluginDataStore {
	constructor(raw) {
		this.raw = raw ?? {};
	}

	async read() {
		return normalizePluginData(this.raw);
	}

	async write(data) {
		this.raw = data;
	}

	async update(updater) {
		const next = updater(await this.read());
		await this.write(next);
		return next;
	}
}

/**
 * In-memory stand-in for BinaryEmbeddingFileStore. Holds the sidecar bytes as
 * an ArrayBuffer (or null when the file is "missing"). Seed with a fixture's
 * embeddings.bin, or with null/garbage to exercise the missing/corrupt paths.
 */
class InMemoryEmbeddingFileStore {
	constructor(buffer) {
		this.buffer = buffer ?? null;
	}

	async read() {
		return this.buffer;
	}

	async write(buffer) {
		this.buffer = buffer;
	}
}

module.exports = {InMemoryPluginDataStore, InMemoryEmbeddingFileStore};

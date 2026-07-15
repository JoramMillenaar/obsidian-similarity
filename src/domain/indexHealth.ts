import { ChunkEntryV2, IndexEntryV2, SCHEMA_VERSION } from "../types";
import { isBinaryLayoutValid } from "./embeddingCodec";

/**
 * Integrity check for the persisted index. The index is split across two files
 * — a slim JSON of entries and a binary sidecar of vectors — so nothing but a
 * check like this enforces that they still agree with each other. Its standing
 * job is to catch any state the current code cannot correctly serve: a schema
 * it predates, a sidecar that can't back the entries pointing into it, or
 * entries whose chunk metadata is self-contradictory.
 *
 * The policy is deliberately asymmetric. A fault that invalidates the whole
 * file pair is UNUSABLE (discard everything and re-index). A fault confined to
 * one entry only costs that entry: it is dropped, and the normal sync plan
 * re-indexes that note, leaving every healthy note's vectors untouched.
 *
 * Anything that fails here is never served. Silently returning a wrong
 * neighbour is worse than paying to recompute one.
 */

/** A fault that invalidates the entire index, not just one entry. */
export type IndexUnusableReason =
	| "legacy-schema"
	| "missing-sidecar"
	| "corrupt-sidecar"
	| "dim-mismatch"
	| "layout-invalid";

export type SidecarState =
	| {status: "missing"}
	| {status: "corrupt"}
	| {status: "ok"; dim: number; count: number; byteLength: number};

export type IndexHealth =
	| {status: "unusable"; reason: IndexUnusableReason}
	| {status: "checked"; validEntries: IndexEntryV2[]; droppedIds: string[]};

export function checkIndexHealth(args: {
	schemaVersion: number;
	embeddingDim: number;
	entries: unknown;
	sidecar: SidecarState;
}): IndexHealth {
	// Written by a version whose vectors this code can't interpret. Discarding
	// beats migrating: the embedding representation has changed too, so the old
	// vectors would have to be recomputed regardless of how they're stored.
	if (args.schemaVersion < SCHEMA_VERSION) {
		return {status: "unusable", reason: "legacy-schema"};
	}

	const entries = Array.isArray(args.entries) ? args.entries : [];
	// An empty index is healthy — there's simply nothing to serve or verify.
	if (entries.length === 0) {
		return {status: "checked", validEntries: [], droppedIds: []};
	}

	if (args.sidecar.status === "missing") {
		return {status: "unusable", reason: "missing-sidecar"};
	}
	if (args.sidecar.status === "corrupt") {
		return {status: "unusable", reason: "corrupt-sidecar"};
	}
	if (args.sidecar.dim !== args.embeddingDim) {
		return {status: "unusable", reason: "dim-mismatch"};
	}
	if (!isBinaryLayoutValid(args.sidecar.byteLength, args.sidecar.dim, args.sidecar.count)) {
		return {status: "unusable", reason: "layout-invalid"};
	}

	const validEntries: IndexEntryV2[] = [];
	const droppedIds: string[] = [];
	const claimedRows = new Set<number>();
	const seenIds = new Set<string>();

	for (const candidate of entries) {
		const entry = validateEntry(candidate, args.sidecar.count, claimedRows, seenIds);
		if (!entry) {
			droppedIds.push(describeId(candidate));
			continue;
		}

		seenIds.add(entry.id);
		for (const chunk of entry.chunks) claimedRows.add(chunk.row);
		validEntries.push(entry);
	}

	return {status: "checked", validEntries, droppedIds};
}

function validateEntry(
	candidate: unknown,
	rowCount: number,
	claimedRows: Set<number>,
	seenIds: Set<string>,
): IndexEntryV2 | null {
	if (!isRecord(candidate)) return null;

	const {id, contentHash, updatedAt, chunks, centroid} = candidate;
	if (!isNonEmptyString(id) || seenIds.has(id)) return null;
	if (!isNonEmptyString(contentHash) || !isNonEmptyString(updatedAt)) return null;
	// Absent is the normal pre-summarizing state; present-but-empty is corruption.
	if (centroid !== undefined && !isNonEmptyString(centroid)) return null;
	// A v1 entry carries its vector inline and has no chunks at all; a v2 entry
	// with no chunks points at nothing and can never match a query.
	if (!Array.isArray(chunks) || chunks.length === 0) return null;

	const rowsInEntry = new Set<number>();
	const validated: ChunkEntryV2[] = [];

	for (const chunk of chunks) {
		const validChunk = validateChunk(chunk, rowCount, claimedRows, rowsInEntry);
		if (!validChunk) return null;

		rowsInEntry.add(validChunk.row);
		validated.push(validChunk);
	}

	return {
		id,
		contentHash,
		updatedAt,
		chunks: validated,
		...(centroid === undefined ? {} : {centroid}),
	};
}

function validateChunk(
	candidate: unknown,
	rowCount: number,
	claimedRows: Set<number>,
	rowsInEntry: Set<number>,
): ChunkEntryV2 | null {
	if (!isRecord(candidate)) return null;

	const {row, start, end, hash} = candidate;

	// The row must address a vector the sidecar actually holds, and must be the
	// only chunk anywhere claiming it — two chunks sharing a row means one of
	// them is silently serving the other's vector.
	if (!isOffset(row) || row >= rowCount) return null;
	if (claimedRows.has(row) || rowsInEntry.has(row)) return null;

	// Every chunk covers at least one sentence, so an empty or inverted span is
	// impossible for real data and marks the entry as untrustworthy.
	if (!isOffset(start) || !isOffset(end) || end <= start) return null;
	if (!isNonEmptyString(hash)) return null;

	return {row, start, end, hash};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isOffset(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Best-effort id for logging a dropped entry, which may be malformed enough to have none. */
function describeId(candidate: unknown): string {
	if (isRecord(candidate) && isNonEmptyString(candidate.id)) return candidate.id;
	return "<unknown>";
}

import { IndexedNote } from "../../types";

/**
 * Compact binary serialization for the note index.
 *
 * Layout (little-endian):
 *   magic:   uint32  ("RNIX")
 *   version: uint16
 *   count:   uint32
 *   repeated `count` times:
 *     idLen:      uint32, id bytes (utf-8)
 *     hashLen:    uint32, contentHash bytes (utf-8)
 *     updatedLen: uint32, updatedAt bytes (utf-8)
 *     embLen:     uint32, then embLen * float32 embedding values
 *
 * Embeddings are stored as float32 rather than JSON float64 text; this both
 * halves their footprint on disk and keeps the parsed index far smaller in
 * memory, which is the whole point of the binary backend. The precision loss
 * is immaterial for cosine similarity.
 */

const MAGIC = 0x524e4958; // "RNIX"
const VERSION = 1;
const HEADER_SIZE = 4 + 2 + 4;

export function encodeIndex(notes: IndexedNote[]): ArrayBuffer {
	const encoder = new TextEncoder();
	const records = notes.map((note) => ({
		id: encoder.encode(note.id),
		hash: encoder.encode(note.contentHash),
		updatedAt: encoder.encode(note.updatedAt),
		embedding: note.embedding,
	}));

	let size = HEADER_SIZE;
	for (const record of records) {
		size += 4 + record.id.length;
		size += 4 + record.hash.length;
		size += 4 + record.updatedAt.length;
		size += 4 + record.embedding.length * 4;
	}

	const buffer = new ArrayBuffer(size);
	const view = new DataView(buffer);
	const bytes = new Uint8Array(buffer);

	let offset = 0;
	view.setUint32(offset, MAGIC, true);
	offset += 4;
	view.setUint16(offset, VERSION, true);
	offset += 2;
	view.setUint32(offset, records.length, true);
	offset += 4;

	for (const record of records) {
		offset = writeBytes(view, bytes, offset, record.id);
		offset = writeBytes(view, bytes, offset, record.hash);
		offset = writeBytes(view, bytes, offset, record.updatedAt);

		view.setUint32(offset, record.embedding.length, true);
		offset += 4;
		for (let i = 0; i < record.embedding.length; i++) {
			view.setFloat32(offset, record.embedding[i], true);
			offset += 4;
		}
	}

	return buffer;
}

export function decodeIndex(buffer: ArrayBuffer): IndexedNote[] {
	if (buffer.byteLength < HEADER_SIZE) return [];

	const view = new DataView(buffer);
	const bytes = new Uint8Array(buffer);
	const decoder = new TextDecoder();

	let offset = 0;
	const magic = view.getUint32(offset, true);
	offset += 4;
	if (magic !== MAGIC) {
		throw new Error("Unrecognized binary index file (bad magic)");
	}

	const version = view.getUint16(offset, true);
	offset += 2;
	if (version !== VERSION) {
		throw new Error(`Unsupported binary index version: ${version}`);
	}

	const count = view.getUint32(offset, true);
	offset += 4;

	const notes: IndexedNote[] = [];
	for (let n = 0; n < count; n++) {
		let id: string;
		let hash: string;
		let updatedAt: string;
		[id, offset] = readString(view, bytes, decoder, offset);
		[hash, offset] = readString(view, bytes, decoder, offset);
		[updatedAt, offset] = readString(view, bytes, decoder, offset);

		const embLen = view.getUint32(offset, true);
		offset += 4;
		const embedding = new Array<number>(embLen);
		for (let i = 0; i < embLen; i++) {
			embedding[i] = view.getFloat32(offset, true);
			offset += 4;
		}

		notes.push({id, contentHash: hash, updatedAt, embedding});
	}

	return notes;
}

/**
 * Reads only the note count from the header without decoding the full index.
 * Used for cheap emptiness checks.
 */
export function readIndexCount(buffer: ArrayBuffer): number {
	if (buffer.byteLength < HEADER_SIZE) return 0;
	const view = new DataView(buffer);
	if (view.getUint32(0, true) !== MAGIC) return 0;
	return view.getUint32(6, true);
}

function writeBytes(
	view: DataView,
	bytes: Uint8Array,
	offset: number,
	data: Uint8Array,
): number {
	view.setUint32(offset, data.length, true);
	offset += 4;
	bytes.set(data, offset);
	return offset + data.length;
}

function readString(
	view: DataView,
	bytes: Uint8Array,
	decoder: TextDecoder,
	offset: number,
): [string, number] {
	const length = view.getUint32(offset, true);
	offset += 4;
	const value = decoder.decode(bytes.subarray(offset, offset + length));
	return [value, offset + length];
}

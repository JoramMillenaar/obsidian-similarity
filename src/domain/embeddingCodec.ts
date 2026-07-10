/**
 * Pure binary codec for the embeddings sidecar. No Obsidian imports, no I/O —
 * just ArrayBuffer <-> Float32Array framing so it stays unit-testable with
 * plain buffers and reusable from any infra adapter.
 *
 * Layout (little-endian):
 *   offset 0:  magic     uint32   0x53494D42 ("SIMB")
 *   offset 4:  version   uint8    1
 *   offset 5:  dtype     uint8    0 = float32
 *   offset 6:  _pad      uint16
 *   offset 8:  dim       uint32
 *   offset 12: count     uint32
 *   offset 16: body      count * dim * 4 bytes
 */
export const HEADER_SIZE = 16;
export const MAGIC = 0x53494d42;
export const VERSION = 1;
export const DTYPE_F32 = 0;

export type DecodedEmbeddings = {
	version: number;
	dtype: number;
	dim: number;
	count: number;
	embeddings: Float32Array;
};

export function isBinaryLayoutValid(byteLength: number, dim: number, count: number): boolean {
	return byteLength - HEADER_SIZE === count * dim * 4;
}

/** Allocates exactly HEADER_SIZE + count*dim*4 bytes and returns that exact-sized buffer. */
export function encodeEmbeddings(embeddings: Float32Array, dim: number): ArrayBuffer {
	if (embeddings.length === 0) {
		const buffer = new ArrayBuffer(HEADER_SIZE);
		writeHeader(buffer, dim, 0);
		return buffer;
	}

	if (dim <= 0 || embeddings.length % dim !== 0) {
		throw new Error(
			`encodeEmbeddings: embeddings length (${embeddings.length}) is not a multiple of dim (${dim})`,
		);
	}

	const count = embeddings.length / dim;
	const buffer = new ArrayBuffer(HEADER_SIZE + count * dim * 4);
	writeHeader(buffer, dim, count);
	new Float32Array(buffer, HEADER_SIZE).set(embeddings);
	return buffer;
}

/** Zero-copy decode: `embeddings` is a view straight over `buffer`. */
export function decodeEmbeddings(buffer: ArrayBuffer): DecodedEmbeddings {
	if (buffer.byteLength < HEADER_SIZE) {
		throw new Error("decodeEmbeddings: buffer too small for header");
	}

	const view = new DataView(buffer);
	const magic = view.getUint32(0, true);
	if (magic !== MAGIC) {
		throw new Error("decodeEmbeddings: invalid magic number");
	}

	const version = view.getUint8(4);
	if (version !== VERSION) {
		throw new Error(`decodeEmbeddings: unsupported version ${version}`);
	}

	const dtype = view.getUint8(5);
	const dim = view.getUint32(8, true);
	const count = view.getUint32(12, true);

	if (!isBinaryLayoutValid(buffer.byteLength, dim, count)) {
		throw new Error("decodeEmbeddings: layout size mismatch");
	}

	const embeddings = new Float32Array(buffer, HEADER_SIZE, dim * count);
	return {version, dtype, dim, count, embeddings};
}

function writeHeader(buffer: ArrayBuffer, dim: number, count: number): void {
	const view = new DataView(buffer);
	view.setUint32(0, MAGIC, true);
	view.setUint8(4, VERSION);
	view.setUint8(5, DTYPE_F32);
	view.setUint16(6, 0, true);
	view.setUint32(8, dim, true);
	view.setUint32(12, count, true);
}

/**
 * Reader for the TyCHO data container, data.tyd, version 1 (spec/tycho-scene.md, section 1).
 * The file holds a 12-byte preamble, a JSON header, and the payload. Each view is stored raw, as its
 * typed bytes aligned to 8, or as shuffle-delta-deflate, in chunks of rows that the native DecompressionStream inflates.
 * Raw views are zero-copy over the caller's buffer where the platform is little endian and the
 * buffer is aligned to the item size, and copied otherwise. Encoded views are decoded by
 * `Container.parse`, so that reading a view stays synchronous.
 */
import { fail, TychoError } from './errors.js';

export type Dtype = 'int8' | 'uint8' | 'int16' | 'uint16' | 'int32' | 'uint32' | 'float32' | 'float64';

export type TypedArray = Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array;

/** One named array, with its elements flat in C order (rule D4), its shape, and its dtype. */
export interface ArrayView {
  readonly name: string;
  readonly dtype: Dtype;
  readonly shape: readonly number[];
  readonly data: TypedArray;
}

/** The interface through which the evaluator reads arrays. `view` throws for a name that is missing. */
export interface DataStore {
  has(name: string): boolean;
  view(name: string): ArrayView;
}

/** A view stored as its little-endian bytes in C order, at `offset` in the payload. */
export interface RawViewInfo {
  dtype: Dtype;
  shape: number[];
  encoding: 'raw';
  offset: number;
  length: number;
}

/** A view stored in chunks of `chunk_rows` rows, each an `[offset, length]` in the payload (rule D5). */
export interface EncodedViewInfo {
  dtype: Dtype;
  shape: number[];
  encoding: 'shuffle-delta-deflate';
  chunk_rows: number;
  chunks: [number, number][];
}

export type ViewInfo = RawViewInfo | EncodedViewInfo;

export interface DataHeader {
  format: 'tycho-data';
  version: 1;
  generator?: string;
  meta?: Record<string, unknown>;
  views: Record<string, ViewInfo>;
}

type TypedArrayConstructor = {
  new (buffer: ArrayBufferLike, byteOffset: number, length: number): TypedArray;
  new (length: number): TypedArray;
  readonly BYTES_PER_ELEMENT: number;
};

const CONSTRUCTORS: Record<Dtype, TypedArrayConstructor> = {
  int8: Int8Array,
  uint8: Uint8Array,
  int16: Int16Array,
  uint16: Uint16Array,
  int32: Int32Array,
  uint32: Uint32Array,
  float32: Float32Array,
  float64: Float64Array,
};

const LITTLE_ENDIAN_HOST = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export function isDtype(s: unknown): s is Dtype {
  return typeof s === 'string' && Object.hasOwn(CONSTRUCTORS, s);
}

export function itemSize(dtype: Dtype): number {
  return CONSTRUCTORS[dtype].BYTES_PER_ELEMENT;
}

/** Reads `count` little-endian items starting at `byteOffset`, copying through a DataView. */
function copyLittleEndian(bytes: DataView, byteOffset: number, count: number, dtype: Dtype): TypedArray {
  const out = new CONSTRUCTORS[dtype](count);
  const size = itemSize(dtype);
  const read: (o: number) => number = {
    int8: (o: number) => bytes.getInt8(o),
    uint8: (o: number) => bytes.getUint8(o),
    int16: (o: number) => bytes.getInt16(o, true),
    uint16: (o: number) => bytes.getUint16(o, true),
    int32: (o: number) => bytes.getInt32(o, true),
    uint32: (o: number) => bytes.getUint32(o, true),
    float32: (o: number) => bytes.getFloat32(o, true),
    float64: (o: number) => bytes.getFloat64(o, true),
  }[dtype];
  for (let i = 0; i < count; i++) out[i] = read(byteOffset + i * size);
  return out;
}

/** Inflates one zlib stream into `out`, and throws a TychoError that gives `where` unless the stream inflates to as many bytes as `out` holds (rule D5). */
async function inflate(src: Uint8Array, out: Uint8Array, where: string): Promise<void> {
  const expected = out.length;
  const stream = new DecompressionStream('deflate');
  const writer = stream.writable.getWriter();
  // errors surface on the readable side, where they are reported
  writer.write(src as Uint8Array<ArrayBuffer>).catch(() => {});
  writer.close().catch(() => {});
  const reader = stream.readable.getReader();
  let at = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (at + value.length > expected) {
        reader.cancel().catch(() => {});
        fail('D5', `${where} inflates to more than the ${expected} bytes of its rows`);
      }
      out.set(value, at);
      at += value.length;
    }
  } catch (e) {
    if (e instanceof TychoError) throw e;
    const why = (e as Error).message;
    fail('D5', `${where} does not inflate${why ? `: ${why}` : ''}`);
  }
  if (at !== expected) fail('D5', `${where} inflates to ${at} bytes, not the ${expected} of its rows`);
}

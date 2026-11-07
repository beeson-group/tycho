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

export const DATA_VERSION = 1;
const MAGIC = [0x54, 0x59, 0x43, 0x44]; // "TYCD"
const PREAMBLE = 12;
const VIEW_KEYS: Record<string, Set<string>> = {
  raw: new Set(['dtype', 'shape', 'encoding', 'offset', 'length']),
  'shuffle-delta-deflate': new Set(['dtype', 'shape', 'encoding', 'chunk_rows', 'chunks']),
};

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

const isCount = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
const isObject = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);

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

/**
 * Undoes the shuffle and the delta of one chunk of `m` rows of `w` elements of `size` bytes, from
 * the inflated bytes `t`, into `out` at `byteOffset`. The values are built from their bytes
 * arithmetically and stored through unsigned arrays, which wrap, so that the result is in the
 * host's byte order.
 */
function restore(t: Uint8Array, m: number, w: number, size: number, out: ArrayBuffer, byteOffset: number): void {
  const n = m * w;
  if (size === 1) {
    const o = new Uint8Array(out, byteOffset, n);
    o.set(t.subarray(0, Math.min(w, n)));
    for (let e = w; e < n; e++) o[e] = t[e]! + o[e - w]!;
  } else if (size === 2) {
    const o = new Uint16Array(out, byteOffset, n);
    for (let e = 0; e < n; e++) {
      const v = t[e]! | (t[n + e]! << 8);
      o[e] = e < w ? v : v + o[e - w]!;
    }
  } else if (size === 4) {
    const o = new Uint32Array(out, byteOffset, n);
    const n2 = 2 * n;
    const n3 = 3 * n;
    for (let e = 0; e < n; e++) {
      const v = (t[e]! | (t[n + e]! << 8) | (t[n2 + e]! << 16) | (t[n3 + e]! << 24)) >>> 0;
      o[e] = e < w ? v : v + o[e - w]!;
    }
  } else {
    // each element is two 32-bit halves, the low one first in memory on a little-endian host
    const o = new Uint32Array(out, byteOffset, 2 * n);
    const lo = LITTLE_ENDIAN_HOST ? 0 : 1;
    const hi = 1 - lo;
    for (let e = 0; e < n; e++) {
      let a = (t[e]! | (t[n + e]! << 8) | (t[2 * n + e]! << 16) | (t[3 * n + e]! << 24)) >>> 0;
      let b = (t[4 * n + e]! | (t[5 * n + e]! << 8) | (t[6 * n + e]! << 16) | (t[7 * n + e]! << 24)) >>> 0;
      if (e >= w) {
        const p = 2 * (e - w);
        a += o[p + lo]!;
        b += o[p + hi]! + (a > 0xffffffff ? 1 : 0);
      }
      o[2 * e + lo] = a;
      o[2 * e + hi] = b;
    }
  }
}

/** The size in bytes of a view's longest chunk once inflated. */
function chunkBytes(info: EncodedViewInfo): number {
  return Math.min(info.chunk_rows, info.shape[0]!) * info.shape.slice(1).reduce((a, b) => a * b, 1) * itemSize(info.dtype);
}

/**
 * Decodes a shuffle-delta-deflate view into a new array, one chunk after another, each inflated
 * into `scratch` (rule D5). In Chrome, decoding one chunk at a time is as fast as decoding every chunk
 * at once, and it leaves less garbage behind.
 */
async function decodeView(name: string, info: EncodedViewInfo, payload: Uint8Array, scratch: Uint8Array): Promise<TypedArray> {
  const size = itemSize(info.dtype);
  const rows = info.shape[0]!;
  const width = info.shape.slice(1).reduce((a, b) => a * b, 1);
  const out = new ArrayBuffer(rows * width * size);
  for (const [k, [offset, length]] of info.chunks.entries()) {
    const first = k * info.chunk_rows;
    const m = Math.min(info.chunk_rows, rows - first);
    const t = scratch.subarray(0, m * width * size);
    await inflate(payload.subarray(offset, offset + length), t, `chunk ${k} of view ${name}`);
    restore(t, m, width, size, out, first * width * size);
  }
  return new CONSTRUCTORS[info.dtype](out, 0, rows * width);
}

/** Checks one view's record against rules D1, D2 and D5, given the payload's size. */
function checkView(name: string, v: unknown, payloadSize: number): asserts v is ViewInfo {
  if (!isObject(v)) fail('1', `view ${name} is not an object`);
  const keys = typeof v.encoding === 'string' && Object.hasOwn(VIEW_KEYS, v.encoding) ? VIEW_KEYS[v.encoding]! : null;
  if (keys === null) fail('D2', `view ${name} has encoding ${JSON.stringify(v.encoding)}, which this reader does not know`);
  const extra = Object.keys(v).filter((k) => !keys.has(k));
  if (extra.length > 0) fail('D2', `view ${name} has keys ${extra.sort().join(', ')} that this reader does not know`);
  const missing = [...keys].filter((k) => !Object.hasOwn(v, k));
  if (missing.length > 0) fail('D2', `view ${name} lacks the keys ${missing.join(', ')}`);
  if (!isDtype(v.dtype)) fail('D1', `view ${name} has dtype ${JSON.stringify(v.dtype)}, not one of ${Object.keys(CONSTRUCTORS).join(', ')}`);
  const shape = v.shape;
  if (!Array.isArray(shape) || shape.length === 0 || !shape.every(isCount)) {
    fail('D2', `view ${name} has shape ${JSON.stringify(shape)}, not a nonempty list of counts`);
  }
  const expected = shape.reduce((a: number, b: number) => a * b, 1) * itemSize(v.dtype);
  if (!Number.isSafeInteger(expected)) fail('D2', `view ${name} has shape [${shape.join(', ')}], which is too large`);
  if (v.encoding === 'raw') {
    if (!isCount(v.offset) || !isCount(v.length)) fail('D2', `view ${name} has an offset or a length that is not a count`);
    if (v.offset % 8 !== 0) fail('D2', `view ${name} starts at byte ${v.offset}, which is not a multiple of 8`);
    if (v.length !== expected) {
      fail('D2', `view ${name} has length ${v.length}, while shape [${shape.join(', ')}] of ${v.dtype} takes ${expected} bytes`);
    }
    if (v.offset + v.length > payloadSize) {
      fail('D2', `view ${name} runs past the end of the file, at bytes ${v.offset} to ${v.offset + v.length} of the payload`);
    }
    return;
  }
  const rows = v.chunk_rows;
  if (!isCount(rows) || rows < 1) fail('D5', `view ${name} has chunk_rows ${JSON.stringify(rows)}, not a positive integer`);
  if (!Array.isArray(v.chunks)) fail('D5', `the chunks of view ${name} are not a list`);
  const count = Math.ceil(shape[0] / rows);
  if (v.chunks.length !== count) {
    fail('D5', `view ${name} has ${v.chunks.length} chunks, while ${shape[0]} rows in chunks of ${rows} take ${count}`);
  }
  v.chunks.forEach((span: unknown, k: number) => {
    if (!Array.isArray(span) || span.length !== 2 || !span.every(isCount)) fail('D5', `chunk ${k} of view ${name} is not an [offset, length] pair of counts`);
    if (span[0] + span[1] > payloadSize) fail('D5', `chunk ${k} of view ${name} runs past the end of the file`);
  });
}

/** A parsed data.tyd. Raw views are built once, on first access, and encoded views by `parse`. */
export class Container implements DataStore {
  readonly header: DataHeader;
  private readonly bytes: DataView;
  private readonly payloadStart: number;
  private readonly cache = new Map<string, ArrayView>();

  private constructor(header: DataHeader, bytes: DataView, payloadStart: number) {
    this.header = header;
    this.bytes = bytes;
    this.payloadStart = payloadStart;
  }

  /**
   * Parses a data container, checks rules D1 to D3 and D5 for every view, and decodes every encoded
   * view. The decoding rejects a chunk that does not inflate to the byte length of its rows (rule D5).
   */
  static async parse(input: ArrayBufferLike | ArrayBufferView): Promise<Container> {
    const bytes = ArrayBuffer.isView(input) ? new DataView(input.buffer, input.byteOffset, input.byteLength) : new DataView(input);
    const size = bytes.byteLength;
    if (size < PREAMBLE || MAGIC.some((b, i) => bytes.getUint8(i) !== b)) {
      fail('1', 'the bytes are not a TyCHO data container, since they lack the 12-byte preamble that starts with the magic "TYCD"');
    }
    const version = bytes.getUint32(4, true);
    if (version !== DATA_VERSION) {
      fail('D3', `data container version ${version} is not supported, since this reader reads only version ${DATA_VERSION}`);
    }
    const headerLength = bytes.getUint32(8, true);
    if (PREAMBLE + headerLength > size) fail('1', `the header length ${headerLength} runs past the end of the file`);

    // The stated length covers the JSON alone and does not include the zero padding after it. A byte order mark
    // is kept by the decoder, so that JSON.parse rejects it (section 1).
    let header: DataHeader;
    try {
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(new Uint8Array(bytes.buffer, bytes.byteOffset + PREAMBLE, headerLength));
      header = JSON.parse(text) as DataHeader;
    } catch (e) {
      fail('1', `the header is not JSON: ${(e as Error).message}`);
    }
    if (header === null || typeof header !== 'object') fail('1', 'the header is not a JSON object');
    if (header.format !== 'tycho-data') fail('1', `header format is ${JSON.stringify(header.format)}, not "tycho-data"`);
    if (header.version !== DATA_VERSION) {
      fail('D3', `header version ${JSON.stringify(header.version)} is not supported, since this reader reads only version ${DATA_VERSION}`);
    }
    if (header.generator !== undefined && typeof header.generator !== 'string') fail('1', 'the header generator is not a string');
    if (header.meta !== undefined && !isObject(header.meta)) fail('1', 'the header meta is not an object');
    if (!isObject(header.views)) fail('1', 'the header lacks a "views" object');

    const payloadStart = PREAMBLE + headerLength + ((8 - ((PREAMBLE + headerLength) % 8)) % 8);
    const payloadSize = Math.max(0, size - payloadStart);
    for (const [name, v] of Object.entries(header.views)) checkView(name, v, payloadSize);

    const container = new Container(header, bytes, payloadStart);
    const encoded = Object.entries(header.views).filter((e): e is [string, EncodedViewInfo] => e[1].encoding === 'shuffle-delta-deflate');
    if (encoded.length > 0) {
      if (typeof DecompressionStream === 'undefined') fail('D5', 'this runtime lacks DecompressionStream, which encoded views need');
      const payload = new Uint8Array(bytes.buffer, bytes.byteOffset + payloadStart, payloadSize);
      const scratch = new Uint8Array(Math.max(...encoded.map(([, info]) => chunkBytes(info))));
      for (const [name, info] of encoded) {
        const data = await decodeView(name, info, payload, scratch);
        container.cache.set(name, { name, dtype: info.dtype, shape: [...info.shape], data });
      }
    }
    return container;
  }

  has(name: string): boolean {
    return Object.hasOwn(this.header.views, name);
  }

  names(): string[] {
    return Object.keys(this.header.views);
  }

  view(name: string): ArrayView {
    const cached = this.cache.get(name);
    if (cached) return cached;
    if (!this.has(name)) fail('2.1', `the data container lacks view ${JSON.stringify(name)}`);
    const info = this.header.views[name] as RawViewInfo;
    const count = info.length / itemSize(info.dtype);
    const at = this.bytes.byteOffset + this.payloadStart + info.offset;
    const data =
      LITTLE_ENDIAN_HOST && at % itemSize(info.dtype) === 0
        ? new CONSTRUCTORS[info.dtype](this.bytes.buffer, at, count)
        : copyLittleEndian(this.bytes, this.payloadStart + info.offset, count, info.dtype);
    const view: ArrayView = { name, dtype: info.dtype, shape: [...info.shape], data };
    this.cache.set(name, view);
    return view;
  }
}

/**
 * Reader for the TyCHO data container, data.tyd, version 1 (spec/tycho-scene.md, section 1).
 * The file holds a 12-byte preamble, a JSON header, and the payload. Each view is stored raw, as its
 * typed bytes aligned to 8, or as shuffle-delta-deflate, in chunks of rows that the native DecompressionStream inflates.
 * Raw views are zero-copy over the caller's buffer where the platform is little endian and the
 * buffer is aligned to the item size, and copied otherwise. Encoded views are decoded by
 * `Container.parse`, so that reading a view stays synchronous.
 */

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

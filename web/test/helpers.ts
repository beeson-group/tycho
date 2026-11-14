// In-memory data for tests: a DataStore over plain arrays, and a data.tyd encoder.
import { deflateSync } from 'node:zlib';
import type { DataArray, DataStore, Dtype, TypedArray } from '../src/container';
import type { Scene, State } from '../src/scene';

const CTORS = {
  int8: Int8Array,
  uint8: Uint8Array,
  int16: Int16Array,
  uint16: Uint16Array,
  int32: Int32Array,
  uint32: Uint32Array,
  float32: Float32Array,
  float64: Float64Array,
} as const;

export class MemoryStore implements DataStore {
  private readonly arrays = new Map<string, DataArray>();

  add(name: string, values: number[] | number[][], dtype: Dtype = 'float64'): this {
    const rows = values as (number | number[])[];
    const flat = rows.flat() as number[];
    const shape = Array.isArray(rows[0]) ? [rows.length, (rows[0] as number[]).length] : [rows.length];
    this.arrays.set(name, { name, dtype, shape, data: CTORS[dtype].from(flat) as TypedArray });
    return this;
  }

  has(name: string): boolean {
    return this.arrays.has(name);
  }

  array(name: string): DataArray {
    const v = this.arrays.get(name);
    if (!v) throw new Error(`no array ${name}`);
    return v;
  }
}

/** One array for `encodeTyd`, raw unless `chunkRows` is given. */
export interface TydArray {
  name: string;
  dtype: Dtype;
  shape: number[];
  values: number[];
  chunkRows?: number;
}

/** Encodes one chunk of rule `shuffle-delta-deflate` from its little-endian bytes, with the delta of the bit patterns, then the byte shuffle, then zlib. */
function encodeChunk(bytes: Uint8Array, m: number, w: number, size: number): Uint8Array {
  const n = m * w;
  const delta = Uint8Array.from(bytes);
  for (let e = w; e < n; e++) {
    let borrow = 0;
    for (let k = 0; k < size; k++) {
      const x = bytes[e * size + k]! - bytes[(e - w) * size + k]! - borrow;
      delta[e * size + k] = x & 0xff;
      borrow = x < 0 ? 1 : 0;
    }
  }
  const shuffled = new Uint8Array(n * size);
  for (let e = 0; e < n; e++) for (let k = 0; k < size; k++) shuffled[k * n + e] = delta[e * size + k]!;
  return new Uint8Array(deflateSync(shuffled));
}

/** Encodes a data.tyd by hand, following section 1 of spec/tycho-scene.md, independently of the readers. */
export function encodeTyd(arrays: TydArray[], opts: { version?: number; patch?: (h: Record<string, any>) => void } = {}): Uint8Array {
  const infos: Record<string, unknown> = {};
  const bodies: Uint8Array[] = [];
  let offset = 0;
  for (const a of arrays) {
    const bytes = new Uint8Array(CTORS[a.dtype].from(a.values).buffer);
    let stored = bytes;
    if (a.chunkRows === undefined) {
      infos[a.name] = { dtype: a.dtype, shape: a.shape, encoding: 'raw', offset, length: bytes.length };
    } else {
      const size = CTORS[a.dtype].BYTES_PER_ELEMENT;
      const w = a.shape.slice(1).reduce((x, y) => x * y, 1);
      const chunks: Uint8Array[] = [];
      for (let r = 0; r < a.shape[0]!; r += a.chunkRows) {
        const m = Math.min(a.chunkRows, a.shape[0]! - r);
        chunks.push(encodeChunk(bytes.subarray(r * w * size, (r + m) * w * size), m, w, size));
      }
      const spans: [number, number][] = [];
      stored = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const c of chunks) {
        stored.set(c, at);
        spans.push([offset + at, c.length]);
        at += c.length;
      }
      infos[a.name] = { dtype: a.dtype, shape: a.shape, encoding: 'shuffle-delta-deflate', chunk_rows: a.chunkRows, chunks: spans };
    }
    const padded = new Uint8Array(Math.ceil(stored.length / 8) * 8);
    padded.set(stored);
    bodies.push(padded);
    offset += padded.length;
  }
  const header: Record<string, any> = { format: 'tycho-data', version: 2, generator: 'test', meta: {}, arrays: infos };
  opts.patch?.(header);
  const json = new TextEncoder().encode(JSON.stringify(header));
  const bodyStart = Math.ceil((12 + json.length) / 8) * 8;
  const out = new Uint8Array(bodyStart + offset);
  out.set([0x54, 0x59, 0x43, 0x44]);
  const dv = new DataView(out.buffer);
  dv.setUint32(4, opts.version ?? 2, true);
  dv.setUint32(8, json.length, true);
  out.set(json, 12);
  let at = bodyStart;
  for (const b of bodies) (out.set(b, at), (at += b.length));
  return out;
}

export const state = (panel = 'main', channel = 'time', extra: Partial<State> = {}): State => ({
  clock: { channel },
  panels: { p1: { panel } },
  layout: { kind: 'panel', id: 'p1' },
  ...extra,
});

/** A minimal scene: one frame "a", one trajectory set "s" in it, and a panel "main" drawing every trajectory. */
export function baseScene(over: Partial<Scene> = {}): Scene {
  return {
    format: 'tycho-scene',
    version: '0.2',
    frames: { a: {} },
    trajectory_sets: { s: { frame: 'a', trajectories: 1, offsets: 'off', positions: 'pos', channels: { time: { array: 'time' } } } },
    clock: { mode: 'fraction', channels: ['time', '@index'], frame_count: 4 },
    panels: {
      main: { frame: 'a', reference: { sets: { set: 's' }, member: { index: 0 } }, layers: [{ kind: 'trajectories', sets: { set: 's' }, members: 'all' }] },
    },
    initial: state(),
    ...over,
  };
}

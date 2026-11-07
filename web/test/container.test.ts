import { describe, expect, it } from 'vitest';
import { Container, decodeEmbedded, type Dtype, type EncodedViewInfo, type TypedArray } from '../src/container';
import { TychoError } from '../src/errors';
import { encodeTyd, type TydArray } from './helpers';

const rule = async (f: () => unknown): Promise<string> => {
  try {
    await f();
  } catch (e) {
    if (e instanceof TychoError) return e.rule;
    throw e;
  }
  return 'no error';
};

const bits = (a: TypedArray): number[] => Array.from(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));

// the extremes of every dtype, and for floats the values whose bit patterns a careless decoder changes
const VALUES: Record<Dtype, number[]> = {
  int8: [-128, 127, 0, -1, 5, 6],
  uint8: [0, 255, 7, 8, 254, 1],
  int16: [-32768, 32767, 0, -1, 2, 3],
  uint16: [0, 65535, 1, 65534, 3, 4],
  int32: [-2147483648, 2147483647, 0, -1, 2, 3],
  uint32: [0, 4294967295, 1, 4294967294, 3, 4],
  float32: [0.5, -1.25, -0, Infinity, -Infinity, NaN, 1e-45, 3.4e38],
  float64: [Math.PI, -Math.E, -0, 5e-324, 1.7976931348623157e308, -Infinity, NaN, 1e-300],
};
const DTYPES = Object.keys(VALUES) as Dtype[];
const CTORS: Record<Dtype, { from(x: number[]): TypedArray }> = {
  int8: Int8Array,
  uint8: Uint8Array,
  int16: Int16Array,
  uint16: Uint16Array,
  int32: Int32Array,
  uint32: Uint32Array,
  float32: Float32Array,
  float64: Float64Array,
};

/** `rows` rows of `width` values, cycling through the dtype's values. */
function values(dtype: Dtype, rows: number, width: number): number[] {
  const base = VALUES[dtype];
  return Array.from({ length: rows * width }, (_, i) => base[i % base.length]!);
}

describe('data.tyd version 1', () => {
  it('round-trips every dtype raw and encoded, bit for bit (D1, D4, D5)', async () => {
    const arrays: TydArray[] = [];
    for (const dtype of DTYPES) {
      arrays.push({ name: `${dtype}/raw`, dtype, shape: [4, 3], values: values(dtype, 4, 3) });
      // shorter than one chunk, one full chunk, and three chunks with a short last one
      arrays.push({ name: `${dtype}/short`, dtype, shape: [4, 3], values: values(dtype, 4, 3), chunkRows: 5 });
      arrays.push({ name: `${dtype}/one`, dtype, shape: [4, 3], values: values(dtype, 4, 3), chunkRows: 4 });
      arrays.push({ name: `${dtype}/three`, dtype, shape: [7, 3], values: values(dtype, 7, 3), chunkRows: 3 });
      arrays.push({ name: `${dtype}/flat`, dtype, shape: [9], values: values(dtype, 9, 1), chunkRows: 2 });
      arrays.push({ name: `${dtype}/cube`, dtype, shape: [3, 2, 2], values: values(dtype, 3, 4), chunkRows: 2 });
    }
    const c = await Container.parse(encodeTyd(arrays));
    for (const a of arrays) {
      const v = c.view(a.name);
      expect(v.dtype).toBe(a.dtype);
      expect(v.shape).toEqual(a.shape);
      expect(bits(v.data), a.name).toEqual(bits(CTORS[a.dtype].from(a.values)));
    }
    expect(c.header.views['float64/three']!.encoding).toBe('shuffle-delta-deflate');
    expect((c.header.views['float64/three'] as EncodedViewInfo).chunks).toHaveLength(3);
  });

  it('wraps the delta of integer bit patterns at every width', async () => {
    const arrays: TydArray[] = [
      { name: 'u8', dtype: 'uint8', shape: [4], values: [255, 0, 255, 1], chunkRows: 4 },
      { name: 'u16', dtype: 'uint16', shape: [3], values: [65535, 0, 65535], chunkRows: 4 },
      { name: 'u32', dtype: 'uint32', shape: [3], values: [4294967295, 0, 4294967295], chunkRows: 4 },
      // the low half of each float64 overflows, and the high half thus takes a carry
      { name: 'f64', dtype: 'float64', shape: [4, 2], values: [1, -1, 1 + 2 ** -52, -2, 2 ** -1074, 3, -0, Number.MAX_VALUE], chunkRows: 4 },
    ];
    const c = await Container.parse(encodeTyd(arrays));
    for (const a of arrays) expect(bits(c.view(a.name).data), a.name).toEqual(bits(CTORS[a.dtype].from(a.values)));
  });

  it('reads empty views raw and encoded (D2)', async () => {
    const c = await Container.parse(
      encodeTyd([
        { name: 'none', dtype: 'float64', shape: [0, 3], values: [], chunkRows: 4 },
        { name: 'thin', dtype: 'float32', shape: [3, 0], values: [], chunkRows: 2 },
        { name: 'raw', dtype: 'uint32', shape: [0], values: [] },
      ]),
    );
    expect((c.header.views.none as EncodedViewInfo).chunks).toEqual([]);
    expect((c.header.views.thin as EncodedViewInfo).chunks).toHaveLength(2);
    for (const n of ['none', 'thin', 'raw']) expect(c.view(n).data.length).toBe(0);
    expect(c.view('thin').shape).toEqual([3, 0]);
  });

  it('views are zero-copy when raw and aligned, and copied otherwise', async () => {
    const bytes = encodeTyd([{ name: 'x', dtype: 'float64', shape: [2], values: [1, 2] }]);
    const c = await Container.parse(bytes);
    expect(c.view('x').data.buffer).toBe(bytes.buffer);
    const shifted = new Uint8Array(bytes.length + 1);
    shifted.set(bytes, 1);
    const d = await Container.parse(shifted.subarray(1));
    expect(Array.from(d.view('x').data)).toEqual([1, 2]);
    const e = await Container.parse(shifted.subarray(1).slice());
    expect(Array.from(e.view('x').data)).toEqual([1, 2]);
  });

  it('rejects versions 0, 2, and 3 (D3)', async () => {
    for (const version of [0, 2, 3]) expect(await rule(() => Container.parse(encodeTyd([], { version })))).toBe('D3');
    expect(await rule(() => Container.parse(encodeTyd([], { patch: (h) => (h.version = 2) })))).toBe('D3');
  });

  it('rejects a length that does not match the shape (D2)', async () => {
    const bytes = encodeTyd([{ name: 'x', dtype: 'float64', shape: [2], values: [1, 2] }], {
      patch: (h) => (h.views.x.shape = [3]),
    });
    expect(await rule(() => Container.parse(bytes))).toBe('D2');
  });

  it('rejects a view that runs past the end of the file (D2)', async () => {
    const bytes = encodeTyd([{ name: 'x', dtype: 'float64', shape: [2], values: [1, 2] }], {
      patch: (h) => (h.views.x.offset = 8),
    });
    expect(await rule(() => Container.parse(bytes))).toBe('D2');
  });

  it('rejects an unknown view key, an unknown encoding, and a missing key (D2)', async () => {
    const x = (patch: (h: Record<string, any>) => void, chunkRows?: number) =>
      Container.parse(encodeTyd([{ name: 'x', dtype: 'float64', shape: [2], values: [1, 2], chunkRows }], { patch }));
    expect(await rule(() => x((h) => (h.views.x.filters = ['shuffle'])))).toBe('D2');
    expect(await rule(() => x((h) => (h.views.x.chunk_rows = 2)))).toBe('D2');
    expect(await rule(() => x((h) => (h.views.x.offset = 0), 2))).toBe('D2');
    expect(await rule(() => x((h) => (h.views.x.encoding = 'zstd')))).toBe('D2');
    expect(await rule(() => x((h) => delete h.views.x.encoding))).toBe('D2');
    expect(await rule(() => x((h) => delete h.views.x.length))).toBe('D2');
    expect(await rule(() => x((h) => delete h.views.x.chunks, 2))).toBe('D2');
  });

  it('rejects an unknown dtype (D1) and a shape without an axis (D2)', async () => {
    const x = (patch: (h: Record<string, any>) => void) => Container.parse(encodeTyd([{ name: 'x', dtype: 'float64', shape: [1], values: [1] }], { patch }));
    expect(await rule(() => x((h) => (h.views.x.dtype = 'float16')))).toBe('D1');
    expect(await rule(() => x((h) => (h.views.x.shape = [])))).toBe('D2');
  });

  it('rejects an offset that is not a multiple of 8 and a shape too large to size (D2)', async () => {
    expect(
      await rule(() =>
        Container.parse(
          encodeTyd([{ name: 'x', dtype: 'float64', shape: [2], values: [1, 2] }], {
            patch: (h) => ((h.views.x.offset = 4), (h.views.x.length = 8), (h.views.x.shape = [1])),
          }),
        ),
      ),
    ).toBe('D2');
    expect(
      await rule(() =>
        Container.parse(encodeTyd([{ name: 'x', dtype: 'uint8', shape: [0], values: [] }], { patch: (h) => (h.views.x.shape = [4294967296, 4294967296]) })),
      ),
    ).toBe('D2');
  });
});

import { describe, expect, it } from 'vitest';
import { Container, decodeEmbedded, type Dtype, type EncodedViewInfo, type TypedArray } from '../src/container';
import { encodeTyd, type TydArray } from './helpers';

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
});

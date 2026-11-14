import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Container, decodeEmbedded, type Dtype, type EncodedArrayInfo, type TypedArray } from '../src/container';
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

/** Where the first chunk of array x starts in the file, and its length. */
function firstChunk(bytes: Uint8Array): [number, number] {
  const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + length)));
  const [offset, size] = (header.arrays.x as EncodedArrayInfo).chunks[0]!;
  return [Math.ceil((12 + length) / 8) * 8 + offset, size];
}

describe('data.tyd version 2', () => {
  it('round-trips every dtype raw and encoded, bit for bit (array-dtype, c-order, shuffle-delta-deflate)', async () => {
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
      const v = c.array(a.name);
      expect(v.dtype).toBe(a.dtype);
      expect(v.shape).toEqual(a.shape);
      expect(bits(v.data), a.name).toEqual(bits(CTORS[a.dtype].from(a.values)));
    }
    expect(c.header.arrays['float64/three']!.encoding).toBe('shuffle-delta-deflate');
    expect((c.header.arrays['float64/three'] as EncodedArrayInfo).chunks).toHaveLength(3);
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
    for (const a of arrays) expect(bits(c.array(a.name).data), a.name).toEqual(bits(CTORS[a.dtype].from(a.values)));
  });

  it('reads empty arrays raw and encoded (array-keys)', async () => {
    const c = await Container.parse(
      encodeTyd([
        { name: 'none', dtype: 'float64', shape: [0, 3], values: [], chunkRows: 4 },
        { name: 'thin', dtype: 'float32', shape: [3, 0], values: [], chunkRows: 2 },
        { name: 'raw', dtype: 'uint32', shape: [0], values: [] },
      ]),
    );
    expect((c.header.arrays.none as EncodedArrayInfo).chunks).toEqual([]);
    expect((c.header.arrays.thin as EncodedArrayInfo).chunks).toHaveLength(2);
    for (const n of ['none', 'thin', 'raw']) expect(c.array(n).data.length).toBe(0);
    expect(c.array('thin').shape).toEqual([3, 0]);
  });

  it('arrays are zero-copy when raw and aligned, and copied otherwise', async () => {
    const bytes = encodeTyd([{ name: 'x', dtype: 'float64', shape: [2], values: [1, 2] }]);
    const c = await Container.parse(bytes);
    expect(c.array('x').data.buffer).toBe(bytes.buffer);
    const shifted = new Uint8Array(bytes.length + 1);
    shifted.set(bytes, 1);
    const d = await Container.parse(shifted.subarray(1));
    expect(Array.from(d.array('x').data)).toEqual([1, 2]);
    const e = await Container.parse(shifted.subarray(1).slice());
    expect(Array.from(e.array('x').data)).toEqual([1, 2]);
  });

  it('rejects versions 0, 1, and 3 (container-version)', async () => {
    for (const version of [0, 1, 3]) expect(await rule(() => Container.parse(encodeTyd([], { version })))).toBe('container-version');
    expect(await rule(() => Container.parse(encodeTyd([], { patch: (h) => (h.version = 1) })))).toBe('container-version');
  });

  it('rejects a length that does not match the shape (array-keys)', async () => {
    const bytes = encodeTyd([{ name: 'x', dtype: 'float64', shape: [2], values: [1, 2] }], {
      patch: (h) => (h.arrays.x.shape = [3]),
    });
    expect(await rule(() => Container.parse(bytes))).toBe('array-keys');
  });

  it('rejects an array that runs past the end of the file (array-keys)', async () => {
    const bytes = encodeTyd([{ name: 'x', dtype: 'float64', shape: [2], values: [1, 2] }], {
      patch: (h) => (h.arrays.x.offset = 8),
    });
    expect(await rule(() => Container.parse(bytes))).toBe('array-keys');
  });

  it('rejects an unknown array key, an unknown encoding, and a missing key (array-keys)', async () => {
    const x = (patch: (h: Record<string, any>) => void, chunkRows?: number) =>
      Container.parse(encodeTyd([{ name: 'x', dtype: 'float64', shape: [2], values: [1, 2], chunkRows }], { patch }));
    expect(await rule(() => x((h) => (h.arrays.x.filters = ['shuffle'])))).toBe('array-keys');
    expect(await rule(() => x((h) => (h.arrays.x.chunk_rows = 2)))).toBe('array-keys');
    expect(await rule(() => x((h) => (h.arrays.x.offset = 0), 2))).toBe('array-keys');
    expect(await rule(() => x((h) => (h.arrays.x.encoding = 'zstd')))).toBe('array-keys');
    expect(await rule(() => x((h) => delete h.arrays.x.encoding))).toBe('array-keys');
    expect(await rule(() => x((h) => delete h.arrays.x.length))).toBe('array-keys');
    expect(await rule(() => x((h) => delete h.arrays.x.chunks, 2))).toBe('array-keys');
  });

  it('rejects an unknown dtype (array-dtype) and a shape without an axis (array-keys)', async () => {
    const x = (patch: (h: Record<string, any>) => void) => Container.parse(encodeTyd([{ name: 'x', dtype: 'float64', shape: [1], values: [1] }], { patch }));
    expect(await rule(() => x((h) => (h.arrays.x.dtype = 'float16')))).toBe('array-dtype');
    expect(await rule(() => x((h) => (h.arrays.x.shape = [])))).toBe('array-keys');
  });

  it('rejects chunks that do not match the shape or run past the end (shuffle-delta-deflate)', async () => {
    const x = (patch: (h: Record<string, any>) => void) =>
      Container.parse(encodeTyd([{ name: 'x', dtype: 'float64', shape: [5, 2], values: [...Array(10).keys()], chunkRows: 2 }], { patch }));
    expect(await rule(() => x(() => {}))).toBe('no error');
    expect(await rule(() => x((h) => (h.arrays.x.chunk_rows = 0)))).toBe('shuffle-delta-deflate');
    expect(await rule(() => x((h) => (h.arrays.x.chunk_rows = 1.5)))).toBe('shuffle-delta-deflate');
    expect(await rule(() => x((h) => (h.arrays.x.chunk_rows = 3)))).toBe('shuffle-delta-deflate');
    expect(await rule(() => x((h) => h.arrays.x.chunks.pop()))).toBe('shuffle-delta-deflate');
    expect(await rule(() => x((h) => (h.arrays.x.chunks[1][0] += 4096)))).toBe('shuffle-delta-deflate');
    expect(await rule(() => x((h) => (h.arrays.x.chunks[1] = [0])))).toBe('shuffle-delta-deflate');
    expect(await rule(() => x((h) => (h.arrays.x.chunks = {})))).toBe('shuffle-delta-deflate');
  });

  it('rejects a chunk that inflates to the wrong size, a corrupted chunk, and a chunk with bytes after its stream (shuffle-delta-deflate)', async () => {
    const one = (rows: number, patch?: (h: Record<string, any>) => void) =>
      encodeTyd([{ name: 'x', dtype: 'float32', shape: [rows, 3], values: [...Array(rows * 3).keys()], chunkRows: 4 }], { patch });
    // three rows in a chunk that the header declares to hold four, and five rows in a chunk of four
    expect(await rule(() => Container.parse(one(3, (h) => (h.arrays.x.shape = [4, 3]))))).toBe('shuffle-delta-deflate');
    expect(await rule(() => Container.parse(one(4, (h) => ((h.arrays.x.shape = [3, 3]), (h.arrays.x.chunk_rows = 3)))))).toBe('shuffle-delta-deflate');
    const bytes = one(4);
    const [start, length] = firstChunk(bytes);
    // a byte of the deflate data, and one of the Adler-32 checksum
    for (const at of [2, length - 1]) {
      const bad = bytes.slice();
      bad[start + at]! ^= 0x40;
      expect(await rule(() => Container.parse(bad)), `byte ${at}`).toBe('shuffle-delta-deflate');
    }
    // a chunk one byte longer than its stream, with the byte taken from the padding after it
    expect(length % 8).not.toBe(0);
    const junk = one(4, (h) => (h.arrays.x.chunks[0][1] += 1));
    const [at, longer] = firstChunk(junk);
    junk[at + longer - 1] = 7;
    expect(await rule(() => Container.parse(junk))).toBe('shuffle-delta-deflate');
  });

  it('the header length does not count the padding (section 1)', async () => {
    const bytes = encodeTyd([{ name: 'x', dtype: 'float64', shape: [2], values: [1, 2] }]);
    const dv = new DataView(bytes.buffer);
    const stated = dv.getUint32(8, true);
    expect((12 + stated) % 8).not.toBe(0);
    dv.setUint32(8, stated + ((8 - ((12 + stated) % 8)) % 8), true);
    expect(await rule(() => Container.parse(bytes))).toBe('container');
  });

  it('rejects a view entry that is not an object, a views array, and a byte order mark (section 1)', async () => {
    const base = encodeTyd([{ name: 'x', dtype: 'float64', shape: [2], values: [1, 2] }]);
    expect(
      await rule(() => Container.parse(encodeTyd([{ name: 'x', dtype: 'float64', shape: [2], values: [1, 2] }], { patch: (h) => (h.arrays.y = null) }))),
    ).toBe('container');
    expect(await rule(() => Container.parse(encodeTyd([], { patch: (h) => (h.arrays = [null]) })))).toBe('container');
    expect(await rule(() => Container.parse(encodeTyd([], { patch: (h) => (h.generator = 5) })))).toBe('container');
    const bom = new Uint8Array(base.length + 3);
    bom.set(base.subarray(0, 12));
    bom.set([0xef, 0xbb, 0xbf], 12);
    bom.set(base.subarray(12), 15);
    new DataView(bom.buffer).setUint32(8, new DataView(base.buffer).getUint32(8, true) + 3, true);
    expect(await rule(() => Container.parse(bom))).toBe('container');
  });

  it('rejects an offset that is not a multiple of 8 and a shape too large to size (array-keys)', async () => {
    expect(
      await rule(() =>
        Container.parse(
          encodeTyd([{ name: 'x', dtype: 'float64', shape: [2], values: [1, 2] }], {
            patch: (h) => ((h.arrays.x.offset = 4), (h.arrays.x.length = 8), (h.arrays.x.shape = [1])),
          }),
        ),
      ),
    ).toBe('array-keys');
    expect(
      await rule(() =>
        Container.parse(encodeTyd([{ name: 'x', dtype: 'uint8', shape: [0], values: [] }], { patch: (h) => (h.arrays.x.shape = [4294967296, 4294967296]) })),
      ),
    ).toBe('array-keys');
  });

  it('decodes embedded base64 and refuses any other encoding (section 1)', async () => {
    expect(Array.from(decodeEmbedded('AAEC\n/w==', 'base64'))).toEqual([0, 1, 2, 255]);
    expect(await rule(() => decodeEmbedded('H4sI', 'gzip+base64'))).toBe('container');
  });
});

describe('the container fixtures of spec/conformance/containers', () => {
  const read = (name: string) => Container.parse(new Uint8Array(readFileSync(new URL(`../../spec/conformance/containers/${name}`, import.meta.url))));

  it('decode, as pytycho wrote them, to the same bits encoded as raw', async () => {
    const [encoded, raw] = await Promise.all([read('encoded.tyd'), read('raw.tyd')]);
    expect(encoded.names()).toEqual(raw.names());
    for (const name of raw.names()) {
      expect(raw.header.arrays[name]!.encoding).toBe('raw');
      const [a, b] = [encoded.array(name), raw.array(name)];
      expect([a.dtype, a.shape], name).toEqual([b.dtype, b.shape]);
      expect(bits(a.data), name).toEqual(bits(b.data));
    }
    const infos = Object.values(encoded.header.arrays);
    expect(new Set(infos.map((v) => v.encoding))).toEqual(new Set(['raw', 'shuffle-delta-deflate']));
    expect(infos.some((v) => v.encoding === 'shuffle-delta-deflate' && v.chunks.length > 2)).toBe(true);
  });
});

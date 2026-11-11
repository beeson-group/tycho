// Tests the pure parts of the timeline of section 2.11 of spec/tycho-scene.md: the eases and tweens of rules K1 and K2, the window of a camera
// with keys (rule K5), the layout at a time, the formats of rule K7, and the drawing helpers of the stepped colors, the fills, the boxes, and the markers.
import { describe, expect, it } from 'vitest';
import { TychoError } from '../src/errors';
import {
  cameraWindow,
  checkCameraKeys,
  checkKeys,
  clockValue,
  ease,
  loopSeconds,
  numberAt,
  opacityAt,
  segmentAt,
  timeAt,
  tweenValue,
} from '../src/evaluate/timeline';
import { formatNumber } from '../src/runtime/readouts';
import { inset, layoutAt, fillSegment } from '../src/runtime/renderer';
import { boxTicks, markerStroke, tickLabel } from '../src/runtime/paint';
import { stepIndex } from '../src/runtime/colors';
import { tile } from '../src/runtime/tiles';
import type { Clock, Layout } from '../src/scene';

const rule = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    if (e instanceof TychoError) return e.rule;
    throw e;
  }
  return 'no error';
};

describe('eases (rule K2)', () => {
  it('run from 0 to 1, the smooth one as smoothstep and in-out as the cubic of both halves, and hold stays at 0', () => {
    for (const name of ['linear', 'smooth', 'in', 'out', 'in-out']) {
      expect(ease(name, 0)).toBe(0);
      expect(ease(name, 1)).toBe(1);
    }
    expect(ease(undefined, 0.3)).toBe(0.3);
    expect(ease('smooth', 0.25)).toBe(0.25 * 0.25 * (3 - 2 * 0.25));
    expect(ease('in', 0.5)).toBe(0.125);
    expect(ease('out', 0.5)).toBe(0.875);
    expect(ease('in-out', 0.25)).toBe(0.0625);
    expect(ease('in-out', 0.75)).toBe(0.9375);
    expect(ease('hold', 0.99)).toBe(0);
    expect(rule(() => ease('bounce', 0.5))).toBe('K2');
  });
});

describe('tweens (rule K1)', () => {
  const keys = checkKeys(
    [
      [1, 0],
      [3, 10, 'smooth'],
      [3, 20],
      [5, 20],
      [6, 30, 'hold'],
    ],
    'a tween',
  );
  it('hold the first value before the first key and the last after the last key', () => {
    expect(tweenValue(keys, -5)).toBe(0);
    expect(tweenValue(keys, 1)).toBe(0);
    expect(tweenValue(keys, 99)).toBe(30);
  });
  it('blend with the ease of the later key, jump at two keys of one time, and hold under hold', () => {
    expect(tweenValue(keys, 2)).toBe(5);
    expect(tweenValue(keys, 1.5)).toBeCloseTo(10 * ease('smooth', 0.25), 15);
    expect(tweenValue(keys, 3)).toBe(20);
    expect(tweenValue(keys, 4)).toBe(20);
    expect(tweenValue(keys, 5.99)).toBe(20);
    expect(tweenValue(keys, 6)).toBe(30);
  });
  it('find the segment by the last key at or before the time', () => {
    const t = [0, 1, 1, 2];
    expect(
      segmentAt(
        (i) => t[i]!,
        4,
        1,
        () => 'linear',
      ),
    ).toEqual({ i: 2, e: 0 });
    expect(
      segmentAt(
        (i) => t[i]!,
        4,
        -1,
        () => 'linear',
      ),
    ).toEqual({ i: 0, e: null });
    expect(
      segmentAt(
        (i) => t[i]!,
        4,
        2,
        () => 'linear',
      ),
    ).toEqual({ i: 3, e: null });
  });
  it('are refused with decreasing times, an unknown ease, or no key, and give a number or an opacity at a time', () => {
    expect(
      rule(() =>
        checkKeys(
          [
            [2, 0],
            [1, 1],
          ],
          'x',
        ),
      ),
    ).toBe('K1');
    expect(rule(() => checkKeys([[0, 0, 'wobble']], 'x'))).toBe('K2');
    expect(rule(() => checkKeys([], 'x'))).toBe('K1');
    expect(rule(() => checkKeys([[0, 'a']], 'x'))).toBe('K1');
    expect(numberAt(undefined, 3, 7)).toBe(7);
    expect(numberAt(0.5, 3, 7)).toBe(0.5);
    expect(
      opacityAt(
        {
          keys: [
            [0, 0],
            [2, 4],
          ],
        },
        1,
      ),
    ).toBe(1);
  });
});

describe('the clock of a timeline (rule K3)', () => {
  const clock: Clock = {
    mode: 'value',
    channels: ['t'],
    steps: 100,
    seconds: 10,
    keys: [
      [0, 0],
      [5, 50],
      [7, 50],
      [10, 80],
    ],
  };
  it('runs over seconds or 8 seconds a lap, and reads its keys at s = q L', () => {
    expect(loopSeconds(clock)).toBe(10);
    expect(loopSeconds({ laps: 3 })).toBe(24);
    expect(timeAt(clock, 0.25)).toBe(2.5);
    expect(clockValue(clock, 0.25)).toBe(25);
    expect(clockValue(clock, 0.6)).toBe(50);
    expect(clockValue({ ...clock, keys: undefined, range: [2, 4] }, 0.5)).toBe(3);
    expect(rule(() => clockValue({ ...clock, range: [0, 1] }, 0.5))).toBe('K3');
  });
});

describe('camera windows (rule K5)', () => {
  const keys = [
    { at: 0, width: 4, center: [0, 0] as [number, number] },
    { at: 2, width: 1, center: [2, 2] as [number, number], ease: 'linear' as const },
    { at: 4, width: 1, follow: [{ layer: 0, member: 0 }] as [{ layer: number; member: number }] },
  ];
  it('blends centers linearly and widths geometrically, with each center taken at the time', () => {
    const w = cameraWindow(keys, 1, (i) => keys[i]!.center ?? [9, 9]);
    expect(w).toEqual({ center: [1, 1], width: 2, height: null });
    expect(cameraWindow(keys, 3, (i) => keys[i]!.center ?? [4, 6])).toEqual({ center: [3, 4], width: 1, height: null });
    expect(cameraWindow(keys, 9, (i) => keys[i]!.center ?? [4, 6])).toEqual({ center: [4, 6], width: 1, height: null });
    expect(cameraWindow(keys, 3, (i) => (i === 2 ? null : keys[i]!.center!))).toBeNull();
  });
  it('checks its keys', () => {
    expect(rule(() => checkCameraKeys([{ at: 0, width: 1 }], false, 'cam'))).toBe('K5');
    expect(rule(() => checkCameraKeys([{ at: 0, width: 0, center: [0, 0] }], false, 'cam'))).toBe('K5');
    expect(rule(() => checkCameraKeys([{ at: 0, width: 1, height: 1, center: [0, 0] }], false, 'cam'))).toBe('K5');
    expect(
      rule(() =>
        checkCameraKeys(
          [
            { at: 1, width: 1, center: [0, 0] },
            { at: 0, width: 1, center: [0, 0] },
          ],
          false,
          'cam',
        ),
      ),
    ).toBe('K5');
    expect(rule(() => checkCameraKeys([{ at: 0, width: 1, center: [0, 0], ease: 'zoom' }], false, 'cam'))).toBe('K2');
    expect(() => checkCameraKeys([{ at: 0, width: 1, height: 2, center: [0, 0] }], true, 'cam')).not.toThrow();
  });
});

describe('layouts at a time (section 2.11)', () => {
  const layout: Layout = {
    kind: 'split',
    dir: 'row',
    ratio: 0.5,
    keys: [
      [0, 1],
      [1, 0.5, 'smooth'],
    ],
    a: { kind: 'panel', id: 'p1' },
    b: { kind: 'panel', id: 'p2' },
  };
  it('take the ratio of a split from its keys, and a side of share 0 loses its gutter', () => {
    const at0 = layoutAt(layout, 0) as Extract<Layout, { kind: 'split' }>;
    expect(at0.ratio).toBe(1);
    const tiles = tile(at0, { x: 0, y: 0, w: 106, h: 50 }, 6);
    expect(tiles.panels.get('p1')).toEqual({ x: 0, y: 0, w: 106, h: 50 });
    expect(tiles.panels.get('p2')!.w).toBe(0);
    expect(tiles.gutters).toEqual([]);
    expect((layoutAt(layout, 1) as Extract<Layout, { kind: 'split' }>).ratio).toBe(0.5);
    const still: Layout = { ...layout, keys: undefined };
    expect(layoutAt(still, 0)).toBe(still);
  });
  it('inset a panel by the margin of its view', () => {
    expect(inset({ x: 10, y: 20, w: 100, h: 200 }, { top: 0.1, left: 0.25 })).toEqual({ x: 35, y: 40, w: 75, h: 180 });
    expect(inset({ x: 0, y: 0, w: 10, h: 10 }, undefined)).toEqual({ x: 0, y: 0, w: 10, h: 10 });
  });
});

describe('formats of a number part (rule K7)', () => {
  it('write decimals, group thousands with commas, and keep a true minus', () => {
    expect(formatNumber(3.14159, undefined, 1)).toBe('3.1');
    expect(formatNumber(-0.04, undefined, 1)).toBe('0.0');
    expect(formatNumber(1945, undefined, 0, true)).toBe('1,945');
    expect(formatNumber(-1234567.891, undefined, 2, true)).toBe('−1,234,567.89');
    expect(formatNumber(12, 3)).toBe('12.0');
  });
});

describe('drawing helpers (section 2.11)', () => {
  it('step a color by the steps below a value', () => {
    expect([-1, 0, 0.5, 2].map((x) => stepIndex([0, 1], x))).toEqual([0, 0, 1, 2]);
  });
  it('fill the part of a segment above the base, cut where it crosses', () => {
    const out: number[] = [];
    fillSegment([0, -1], [2, 1], 0, out);
    expect(out).toEqual([1, 0, 2, 1, 2, 0]);
    const none: number[] = [];
    fillSegment([0, -1], [2, -1], 0, none);
    expect(none).toEqual([]);
    const all: number[] = [];
    fillSegment([0, 1], [1, 2], 0, all);
    expect(all).toHaveLength(12);
  });
  it('tick a box as matplotlib does, at the smallest of 1, 2, 2.5, and 5 times a power of ten that leaves at most the bins', () => {
    expect(boxTicks(0, 22.06, 9)).toEqual({ values: [0, 2.5, 5, 7.5, 10, 12.5, 15, 17.5, 20], step: 2.5 });
    expect(boxTicks(-0.595, 1.255, 9).step).toBe(0.25);
    expect(boxTicks(-1.15, 1.15, 4)).toEqual({ values: [-1, 0, 1], step: 1 });
    expect(tickLabel(2.5, 2.5)).toBe('2.5');
    expect(tickLabel(-0.5, 0.25)).toBe('−0.50');
    expect(tickLabel(1e-17, 0.2)).toBe('0.0');
  });
  it('stroke a marker by its edge, and a ring, a cross, or a plus by its line', () => {
    expect(markerStroke({ shape: 'disc' }, 10)).toBe(0);
    expect(markerStroke({ shape: 'disc', edge: '#000000', edge_width: 2 }, 10)).toBe(2);
    expect(markerStroke({ shape: 'ring' }, 12)).toBe(2);
    expect(markerStroke({ shape: 'cross', edge_width: 1.5 }, 12)).toBe(1.5);
  });
});

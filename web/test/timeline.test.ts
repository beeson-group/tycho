// Tests the pure parts of the timeline of section 2.11 of spec/tycho-scene.md: the eases and lists of keyframes of rules `keyframes` and `ease`, the window of a camera
// with keys (rule `camera-keyframes`), the layout at a time, the formats of rule `timeline-parts`, and the drawing helpers of the stepped colors, the fills, the boxes, and the markers.
import { describe, expect, it } from 'vitest';
import { TychoError } from '../src/errors';
import { layerClock } from '../src/evaluate/clock';
import { evaluate } from '../src/evaluate/index';
import {
  cameraWindow,
  checkCameraKeyframes,
  checkKeyframes,
  clockValue,
  ease,
  loopSeconds,
  numberAt,
  opacityAt,
  segmentAt,
  timeAt,
  keyframesValue,
} from '../src/evaluate/timeline';
import { formatNumber } from '../src/runtime/readouts';
import { dashRestarts, inset, layoutAt, fillSegment } from '../src/runtime/renderer';
import { boxTicks, linePitch, markerStroke, tickLabel } from '../src/runtime/paint';
import { thresholdIndex } from '../src/runtime/colors';
import { tile } from '../src/runtime/tiles';
import type { Clock, Layout, TrajectoriesLayer } from '../src/scene';
import { loadCorpus } from './corpus';

const rule = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    if (e instanceof TychoError) return e.rule;
    throw e;
  }
  return 'no error';
};

describe('eases (rule `ease`)', () => {
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
    expect(rule(() => ease('bounce', 0.5))).toBe('ease');
  });
});

describe('lists of keyframes (rule `keyframes`)', () => {
  const keys = checkKeyframes(
    [
      [1, 0],
      [3, 10, 'smooth'],
      [3, 20],
      [5, 20],
      [6, 30, 'hold'],
    ],
    'a keyframes',
  );
  it('hold the first value before the first key and the last after the last key', () => {
    expect(keyframesValue(keys, -5)).toBe(0);
    expect(keyframesValue(keys, 1)).toBe(0);
    expect(keyframesValue(keys, 99)).toBe(30);
  });
  it('blend with the ease of the later key, jump at two keys of one time, and hold under hold', () => {
    expect(keyframesValue(keys, 2)).toBe(5);
    expect(keyframesValue(keys, 1.5)).toBeCloseTo(10 * ease('smooth', 0.25), 15);
    expect(keyframesValue(keys, 3)).toBe(20);
    expect(keyframesValue(keys, 4)).toBe(20);
    expect(keyframesValue(keys, 5.99)).toBe(20);
    expect(keyframesValue(keys, 6)).toBe(30);
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
        checkKeyframes(
          [
            [2, 0],
            [1, 1],
          ],
          'x',
        ),
      ),
    ).toBe('keyframes');
    expect(rule(() => checkKeyframes([[0, 0, 'wobble']], 'x'))).toBe('ease');
    expect(rule(() => checkKeyframes([], 'x'))).toBe('keyframes');
    expect(rule(() => checkKeyframes([[0, 'a']], 'x'))).toBe('keyframes');
    expect(numberAt(undefined, 3, 7)).toBe(7);
    expect(numberAt(0.5, 3, 7)).toBe(0.5);
    expect(
      opacityAt(
        {
          keyframes: [
            [0, 0],
            [2, 4],
          ],
        },
        1,
      ),
    ).toBe(1);
  });
});

describe('the clock of a timeline (rule `clock-keyframes`)', () => {
  const clock: Clock = {
    mode: 'epoch',
    channels: ['t'],
    frame_count: 100,
    seconds: 10,
    keyframes: [
      [0, 0],
      [5, 50],
      [7, 50],
      [10, 80],
    ],
  };
  it('runs over seconds or 8 seconds a revolution, and reads its keys at s = q L', () => {
    expect(loopSeconds(clock)).toBe(10);
    expect(loopSeconds({ revolutions: 3 })).toBe(24);
    expect(timeAt(clock, 0.25)).toBe(2.5);
    expect(clockValue(clock, 0.25)).toBe(25);
    expect(clockValue(clock, 0.6)).toBe(50);
    expect(clockValue({ ...clock, keyframes: undefined, range: [2, 4] }, 0.5)).toBe(3);
    expect(rule(() => clockValue({ ...clock, range: [0, 1] }, 0.5))).toBe('clock-keyframes');
  });
});

describe('camera windows (rule `camera-keyframes`)', () => {
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
    expect(rule(() => checkCameraKeyframes([{ at: 0, width: 1 }], false, 'cam'))).toBe('camera-keyframes');
    expect(rule(() => checkCameraKeyframes([{ at: 0, width: 0, center: [0, 0] }], false, 'cam'))).toBe('camera-keyframes');
    expect(rule(() => checkCameraKeyframes([{ at: 0, width: 1, height: 1, center: [0, 0] }], false, 'cam'))).toBe('camera-keyframes');
    expect(
      rule(() =>
        checkCameraKeyframes(
          [
            { at: 1, width: 1, center: [0, 0] },
            { at: 0, width: 1, center: [0, 0] },
          ],
          false,
          'cam',
        ),
      ),
    ).toBe('camera-keyframes');
    expect(rule(() => checkCameraKeyframes([{ at: 0, width: 1, center: [0, 0], ease: 'zoom' }], false, 'cam'))).toBe('ease');
    expect(() => checkCameraKeyframes([{ at: 0, width: 1, height: 2, center: [0, 0] }], true, 'cam')).not.toThrow();
  });
});

describe('what a frame does not compute again', () => {
  it('checks the keys of a camera once, and reads only their window afterward', () => {
    const { scene, data } = loadCorpus('timeline');
    const keys = (scene.panels.plot!.camera as { keyframes: { width: number }[] }).keyframes;
    let reads = 0;
    Object.defineProperty(keys[0], 'width', {
      get: () => {
        reads++;
        return 2;
      },
    });
    evaluate(scene, data, scene.initial, 3);
    const first = reads;
    evaluate(scene, data, scene.initial, 3);
    expect(reads - first).toBeLessThan(first);
  });
  it('builds the clock of a layer once per scene clock', () => {
    const clock: Clock = { mode: 'fraction', channels: ['t'], frame_count: 20, seconds: 10 };
    const own = {
      channel: 't',
      keyframes: [
        [0, 0],
        [10, 4, 'linear'],
      ],
    } as NonNullable<TrajectoriesLayer['clock']>;
    expect(layerClock(clock, own)).toBe(layerClock(clock, own));
    // another scene clock gives another loop length, hence another clock of the layer
    expect(layerClock({ ...clock, seconds: 20 }, own).seconds).toBe(20);
    expect(layerClock(clock, own).seconds).toBe(10);
  });
});

describe('layouts at a time (section 2.11)', () => {
  const layout: Layout = {
    kind: 'split',
    dir: 'row',
    ratio: 0.5,
    keyframes: [
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
    const still: Layout = { ...layout, keyframes: undefined };
    expect(layoutAt(still, 0)).toBe(still);
  });
  it('inset a panel by the margin of its view', () => {
    expect(inset({ x: 10, y: 20, w: 100, h: 200 }, { top: 0.1, left: 0.25 })).toEqual({ x: 35, y: 40, w: 75, h: 180 });
    expect(inset({ x: 0, y: 0, w: 10, h: 10 }, undefined)).toEqual({ x: 0, y: 0, w: 10, h: 10 });
  });
});

describe('formats of a number part (rule `timeline-parts`)', () => {
  it('write decimals, group thousands with commas, and keep a true minus', () => {
    expect(formatNumber(3.14159, undefined, 1)).toBe('3.1');
    expect(formatNumber(-0.04, undefined, 1)).toBe('0.0');
    expect(formatNumber(1945, undefined, 0, true)).toBe('1,945');
    expect(formatNumber(-1234567.891, undefined, 2, true)).toBe('−1,234,567.89');
    expect(formatNumber(12, 3)).toBe('12.0');
  });
});

describe('drawing helpers (section 2.11)', () => {
  it('spaces the lines of a text as matplotlib does, by its linespacing', () => {
    expect(linePitch()).toBeCloseTo(1.15, 12);
    // matplotlib's linespacing=1.5 puts each baseline 0.3 ascents further below the line before
    expect(linePitch(1.5)).toBeCloseTo(1.15 + 0.3 * 0.757, 12);
  });
  it('starts a dash pattern again wherever its trajectory enters the stage, as matplotlib clips a line to its figure', () => {
    const restarts = (xy: number[], dist: number[], from = 0, count = dist.length) => {
      const out: number[] = [];
      dashRestarts(xy, dist, from, count, 0, 0, 10, 10, out, 0);
      return out;
    };
    // four samples along y = 5, from x = -10 to 15, and a stage of 10 by 10: the pattern starts where the trajectory comes in at x = 0
    expect(restarts([-10, 5, -5, 5, 5, 5, 15, 5], [0, 5, 15, 25])).toEqual([0, 10, 10]);
    // a trajectory that starts on the stage starts its pattern at its first sample, and keeps it while it stays on
    expect(restarts([2, 5, 5, 5, 8, 5], [3, 6, 9])).toEqual([3, 3]);
    // a trajectory that leaves the stage and comes back starts its pattern again where it comes back
    expect(restarts([5, 5, 15, 5, 15, 8, 5, 8], [0, 10, 13, 23])).toEqual([0, 0, 18]);
    // a trajectory that never enters the stage starts at its first sample
    expect(restarts([-10, 20, -5, 20, 5, 20], [0, 5, 15])).toEqual([0, 0]);
    // a trajectory that crosses a corner region enters where it meets the first edge inside the stage
    expect(restarts([-5, -5, 5, 5], [0, Math.SQRT2 * 10])[0]).toBeCloseTo((Math.SQRT2 * 10) / 2, 12);
  });
  it('step a color by the steps below a value', () => {
    expect([-1, 0, 0.5, 2].map((x) => thresholdIndex([0, 1], x))).toEqual([0, 0, 1, 2]);
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
    // matplotlib keeps two ticks at least, and steps down when the round step leaves one
    expect(boxTicks(-1.06, -0.94, 2).values.map((v) => Number(v.toFixed(2)))).toEqual([-1.05, -1, -0.95]);
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

describe('a points layer (rule `points`)', () => {
  it('is rejected by the evaluator where it grows on a set that is not periodic, under a clock with revolutions (rule `revolutions`)', () => {
    const c = loadCorpus('revolutions');
    const layers = c.scene.panels.v!.layers;
    const trajectory = layers[5] as TrajectoriesLayer;
    layers[5] = { kind: 'points', sets: trajectory.sets, members: trajectory.members, reveal: 'grow' };
    expect(rule(() => evaluate(c.scene, c.data, c.scene.initial, 0))).toBe('revolutions');
  });
});

import { describe, expect, it } from 'vitest';
import { SetCache } from '../src/evaluate/sets';
import { colormapPosition, hexRgb, mixHex } from '../src/runtime/colors';
import { GeometryCache } from '../src/runtime/geometry';
import {
  formatNumber,
  LAP_SECONDS,
  loopPosition,
  loopSeconds,
  nearestStop,
  positionIndex,
  positionProgress,
  readoutText,
  sliderStops,
} from '../src/runtime/readouts';
import { withVariable } from '../src/runtime/state';
import { ratioAt, tile, withRatio } from '../src/runtime/tiles';
import type { Layout, Readout, Scene } from '../src/scene';
import { validate } from '../src/validate';
import { baseScene, MemoryStore, state } from './helpers';
import { loadCorpus } from './corpus';

describe('formatNumber', () => {
  it('gives digits as significant digits, keeping trailing zeros', () => {
    expect(formatNumber(0.123456, 3)).toBe('0.123');
    expect(formatNumber(0.2, 3)).toBe('0.200');
    expect(formatNumber(12.5, 2)).toBe('13');
    expect(formatNumber(1234.5, 2)).toBe('1.2e3');
    expect(formatNumber(-0.000012345, 2)).toBe('−0.000012');
    expect(formatNumber(-1.2345e-7, 2)).toBe('−1.2e−7');
    expect(formatNumber(-0.5, 2)).toBe('−0.50');
  });
  it('without digits, gives an integer as it is and any other number to six significant digits', () => {
    expect(formatNumber(42)).toBe('42');
    expect(formatNumber(-0)).toBe('0');
    expect(formatNumber(1 / 3)).toBe('0.333333');
    expect(formatNumber(0.1 + 0.2)).toBe('0.3');
    expect(formatNumber(2.5e-9)).toBe('2.5e−9');
    expect(formatNumber(Infinity)).toBe('∞');
  });
});

describe('slider stops (section 2.9)', () => {
  const scene = (): Scene => {
    const s = baseScene({
      variables: {
        c: { kind: 'selector', parameter: 'C', default: 2.9 },
        fam: { kind: 'choice', values: ['x', 'y', 'none'], default: 'x' },
      },
      controls: [{ kind: 'slider', variable: 'c', label: 'C', domain: { tags: { kind: 'orbit' } } }],
    });
    s.track_sets.s = { ...s.track_sets.s!, tracks: 2, tags: { kind: 'orbit', fam: 'x' }, parameters: { C: { view: 'c1' } } };
    s.track_sets.u = { frame: 'a', tracks: 2, offsets: 'off', positions: 'pos', tags: { kind: 'orbit', fam: 'y' }, parameters: { C: { view: 'c2' } } };
    return s;
  };
  const data = () =>
    new MemoryStore()
      .add('off', [0, 2, 4], 'uint32')
      .add('pos', [
        [0, 0],
        [1, 0],
        [2, 0],
        [3, 0],
      ])
      .add('time', [0, 1, 0, 1])
      .add('c1', [3, 1])
      .add('c2', [2, 3]);
  it('are the distinct parameter values of the matched track sets, in increasing order', () => {
    const s = scene();
    const scope = { scene: s, state: s.initial, panel: s.initial.panels.p1! };
    const control = s.controls![0] as Extract<NonNullable<Scene['controls']>[number], { kind: 'slider' }>;
    expect(sliderStops(scope, new SetCache(s, data()), control)).toEqual([1, 2, 3]);
    control.domain = { tags: { fam: { var: 'fam' } } };
    expect(sliderStops(scope, new SetCache(s, data()), control)).toEqual([1, 3]);
    const none = { ...scope, state: withVariable(s, s.initial, 'fam', 'none') };
    expect(sliderStops(none, new SetCache(s, data()), control)).toEqual([]);
  });
  it('nearestStop picks the nearest stop, the lowest index winning a tie', () => {
    expect(nearestStop([1, 2, 3], 2.9)).toBe(2);
    expect(nearestStop([1, 2, 3], 1.5)).toBe(0);
    expect(nearestStop([], 1)).toBe(-1);
  });
});

describe('wall time to loop position', () => {
  // `at` models live playback, with milliseconds since the anchor, 64 steps, and one lap
  const at = (start: number, ms: number, speed = 1, seconds = 8) => loopPosition(start, ms, 1000, 64, speed, seconds);
  it('runs a lap in 8 s at speed 1, and a loop of n laps in 8 n s', () => {
    expect(LAP_SECONDS).toBe(8);
    expect(loopSeconds({ mode: 'fraction', channels: ['@index'], steps: 64 })).toBe(8);
    expect(loopSeconds({ mode: 'fraction', channels: ['@index'], steps: 4320, laps: 9 })).toBe(72);
    expect(at(0, 1000)).toBe(8);
    expect(at(0, 1000, 0.5)).toBe(4);
    expect(at(0, 1000, 1, 72)).toBeCloseTo(64 / 72, 15);
    expect(at(3, -50)).toBe(3);
  });
  it('lies between two frame indices, the index its integer part and the progress its exact place', () => {
    const x = at(0, 1062.5, 0.25);
    expect(x).toBe(2.125);
    expect([positionIndex(x, 64), positionProgress(x, 64)]).toEqual([2, 2.125 / 64]);
    expect([positionIndex(at(5, 8000), 64), positionProgress(at(5, 8000), 64)]).toEqual([5, 5 / 64]);
  });
  it('wraps past the end of the loop and below its start, as stepping back from frame 0 does', () => {
    expect([positionIndex(at(60, 1000), 64), positionProgress(at(60, 1000), 64)]).toEqual([4, 4 / 64]);
    expect([positionIndex(-1, 64), positionProgress(-1, 64)]).toEqual([63, 63 / 64]);
    expect([positionIndex(-0.5, 64), positionProgress(-0.5, 64)]).toEqual([63, 63.5 / 64]);
    expect([positionIndex(-129.25, 64), positionProgress(-129.25, 64)]).toEqual([62, 62.75 / 64]);
    // a position a hair below a multiple of the loop wraps to a progress below 1
    expect(positionProgress(-1e-17, 64)).toBe(0);
  });
});

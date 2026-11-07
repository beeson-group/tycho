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
  it('runs a loop in the seconds of the clock when it gives them, whatever its laps', () => {
    expect(loopSeconds({ mode: 'value', channels: ['time'], steps: 960, range: [-8, 11], seconds: 24 })).toBe(24);
    expect(loopSeconds({ mode: 'fraction', channels: ['@index'], steps: 4320, laps: 9, seconds: 30 })).toBe(30);
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

describe('tiles', () => {
  const layout: Layout = {
    kind: 'split',
    dir: 'row',
    ratio: 0.25,
    a: { kind: 'panel', id: 'p1' },
    b: { kind: 'split', dir: 'col', ratio: 0.5, a: { kind: 'panel', id: 'p2' }, b: { kind: 'panel', id: 'p3' } },
  };
  it('splits the stage by the ratios, less the gutters, in whole pixels', () => {
    const t = tile(layout, { x: 0, y: 0, w: 406, h: 206 }, 6);
    expect(t.panels.get('p1')).toEqual({ x: 0, y: 0, w: 100, h: 206 });
    expect(t.panels.get('p2')).toEqual({ x: 106, y: 0, w: 300, h: 100 });
    expect(t.panels.get('p3')).toEqual({ x: 106, y: 106, w: 300, h: 100 });
    expect(t.gutters.map((g) => [g.path, g.rect])).toEqual([
      ['', { x: 100, y: 0, w: 6, h: 206 }],
      ['b', { x: 106, y: 100, w: 300, h: 6 }],
    ]);
  });
  it('sets a ratio by path, and reads one from a pointer, kept in [0.1, 0.9]', () => {
    const next = withRatio(layout, 'b', 0.8);
    expect(next.kind === 'split' && next.b.kind === 'split' && next.b.ratio).toBe(0.8);
    expect(next.kind === 'split' && next.a).toBe((layout as Extract<Layout, { kind: 'split' }>).a);
    const g = tile(layout, { x: 0, y: 0, w: 406, h: 206 }, 6).gutters[0]!;
    expect(ratioAt(g, 203, 50, 6)).toBe(0.5);
    expect(ratioAt(g, 0, 50, 6)).toBe(0.1);
    expect(ratioAt(g, 999, 50, 6)).toBe(0.9);
  });
});

describe('colors', () => {
  it('parses and mixes hex colors', () => {
    expect(hexRgb('#ff8000')).toEqual([1, 128 / 255, 0]);
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
  });
  it('places a value on a colormap through its range and clip', () => {
    expect(colormapPosition(5, [0, 10])).toBe(0.5);
    expect(colormapPosition(-5, [0, 10])).toBe(0);
    expect(colormapPosition(5, [0, 10], [0.5, 1])).toBe(0.75);
    expect(colormapPosition(3, [3, 3])).toBe(0.5);
  });
});

describe('readouts (section 2.9)', () => {
  const corpus = () => {
    const c = loadCorpus('two-panels');
    const parts: Readout['parts'] = [
      'e=',
      { member: 'e', digits: 3 },
      ' d=',
      { attr: 'd', factor: 2, offset: 1 },
      ' t=',
      { channel: 't', digits: 4 },
      ' i=',
      { clock: 'index' },
      '/',
      { clock: 'steps' },
      ' ',
      { var: 'frame' },
      ' ',
      { var: 'e' },
    ];
    c.scene.readouts = [{ place: 'panel', parts }];
    validate(c.scene, c.data);
    return { ...c, parts, geometry: new GeometryCache(c.scene, c.data) };
  };
  it('reads the driver, its channel at the reading, the clock, and the variables', () => {
    const c = corpus();
    const st = c.scene.initial;
    // p1 drives orbits track 1 (k = 0.5 rounds to 1)
    const set = c.geometry.sets.get('orbits');
    const e = set.parameter('e')[1]!;
    const tc = c.geometry.readings('orbits', 't').clocks[1]!;
    const t = set.channel('t');
    const s = set.start(1);
    const { k, w } = tc.locate(2 / 6);
    const tv = (1 - w) * t[s + k]! + w * t[s + k + 1]!;
    const text = readoutText({ scene: c.scene, geometry: c.geometry, state: st, panel: 'p1', frameIndex: 8 }, c.parts);
    expect(text).toBe(`e=${formatNumber(e, 3)} d=2 t=${formatNumber(tv, 4)} i=2/6 shift ${formatNumber(0.2)}`);
  });
  it('gives a dash for a part that a driver without a matching track set cannot give', () => {
    const c = corpus();
    const st = withVariable(c.scene, c.scene.initial, 'group', 'absent');
    const text = readoutText({ scene: c.scene, geometry: c.geometry, state: st, panel: 'p2', frameIndex: 0 }, c.parts);
    expect(text).toBe('e=— d=— t=— i=0/6 tilt 0.2');
  });
  it('shows a choice by its label and a toggle as on or off', () => {
    const s = baseScene({
      variables: { f: { kind: 'choice', values: ['a', 'b'], labels: ['first', 'second'], default: 'b' }, show: { kind: 'toggle', default: true } },
    });
    const data = new MemoryStore()
      .add('off', [0, 2], 'uint32')
      .add('pos', [
        [0, 0],
        [1, 0],
      ])
      .add('time', [0, 1]);
    const text = readoutText({ scene: s, geometry: new GeometryCache(s, data), state: state(), panel: 'p1', frameIndex: 0 }, [
      { var: 'f' },
      ' ',
      { var: 'show' },
    ]);
    expect(text).toBe('second on');
  });
  it("reads a channel in the driver's lap (C6)", () => {
    // the laps scene runs 3 laps of 24 steps over a loop whose channel a is 0, 0.5, 1, 1.5, 2.5, an advance of 2.5 per lap
    const c = loadCorpus('laps');
    c.scene.readouts = [{ place: 'panel', parts: [{ channel: 'a' }] }];
    validate(c.scene, c.data);
    const geometry = new GeometryCache(c.scene, c.data);
    const read = (channel: string, frameIndex: number) =>
      readoutText({ scene: c.scene, geometry, state: { ...c.scene.initial, clock: { channel } }, panel: 'p1', frameIndex }, c.scene.readouts![0]!.parts);
    // by @index, lap 2 runs from frame 16, and frame 21 is halfway between samples 2 and 3 of lap 2
    expect([4, 8, 12, 16, 20, 21, 22, 23].map((i) => read('@index', i))).toEqual(['1', '2.5', '3.5', '5', '6', '6.25', '6.5', '7']);
    // read by channel a itself, the readout is the loop value 2.5 U = 7.5 q, with loop reading U and progress q
    for (const i of [17, 20, 23]) expect(read('a', i)).toBe(formatNumber((7.5 * i) / 24));
    // during playback, the channel is read at the progress between frames 20 and 21, and the clock part shows the frame index
    const parts: Readout['parts'] = [{ channel: 'a' }, ' at ', { clock: 'index' }];
    const st = { ...c.scene.initial, clock: { channel: '@index' } };
    expect(readoutText({ scene: c.scene, geometry, state: st, panel: 'p1', frameIndex: 20, progress: 20.5 / 24 }, parts)).toBe('6.125 at 20');
  });
});

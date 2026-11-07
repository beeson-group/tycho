// Tests the viewer's controls (its chrome), first the pure helpers behind them, then the shell built under Node on the DOM
// stand-in of dom-shim.ts, without a renderer, since WebGL is not available under Node.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chromeTokens, colormapName, DEFAULT_THEME } from '../src/runtime/colors';
import { buildChip, buildReadout, dropText, fillReadout, TychoViewerElement } from '../src/runtime/element';
import { GeometryCache } from '../src/runtime/geometry';
import { GLYPHS, icon } from '../src/runtime/icons';
import {
  colorbarLink,
  formatNumber,
  fpsText,
  fpsTitle,
  FrameMeter,
  keyAction,
  readoutPieces,
  readoutText,
  readoutTiles,
  sliderStops,
  stopAt,
} from '../src/runtime/readouts';
import { mergeColorbars, type Colorbar } from '../src/runtime/overlay';
import { chipMenu, withAdd, withPlacement } from '../src/runtime/state';
import type { Control, Readout, Scene, State } from '../src/scene';
import { validate } from '../src/validate';
import { loadCorpus } from './corpus';
import { byClass, byTag, FakeElement, installDom } from './dom-shim';

const BROUCKE_CAPTION: Readout['parts'] = [
  'e = ',
  { member: 'eccentricity', digits: 4 },
  ', period ',
  { member: 'period', digits: 5 },
  ' rad, closure error ',
  { member: 'closure_error', digits: 2 },
  ' DU, mu = ',
  { attr: 'mu', digits: 6 },
];

describe('readout tiles', () => {
  it('split the Broucke caption into the tiles e, period in rad, closure error in DU, and mu', () => {
    expect(readoutTiles(BROUCKE_CAPTION)).toEqual([
      { label: 'e', part: 1, unit: '', width: null },
      { label: 'period', part: 3, unit: 'rad', width: null },
      { label: 'closure error', part: 5, unit: 'DU', width: null },
      { label: 'mu', part: 7, unit: '', width: null },
    ]);
  });
  it('put scene constants last, take ":" as well as "=", and give a width to what changes during playback, i.e. a clock or a channel', () => {
    const parts: Readout['parts'] = ['mu: ', { attr: 'mu' }, ', frame ', { clock: 'index' }, ', t = ', { channel: 't' }, ' TU'];
    expect(readoutTiles(parts)).toEqual([
      { label: 'frame', part: 3, unit: '', width: 5 },
      { label: 't', part: 5, unit: 'TU', width: 11 },
      { label: 'mu', part: 1, unit: '', width: null },
    ]);
  });
  it('fail, for the line to show instead, when the text does not have a comma to split at or would be left over', () => {
    expect(readoutTiles(['frame ', { clock: 'index' }, ' of ', { clock: 'steps' }])).toBeNull();
    expect(readoutTiles(['a, b = ', { member: 'x' }])).toBeNull();
    expect(readoutTiles(['x = ', { member: 'x' }, ' km, then'])).toBeNull();
    expect(readoutTiles(['x = ', { member: 'x' }, ', more, y ', { member: 'y' }])).toBeNull();
    expect(readoutTiles([{ member: 'x' }])).toBeNull();
    expect(readoutTiles(['just text'])).toBeNull();
    expect(readoutTiles([', = ', { member: 'x' }])).toBeNull();
  });
  it('read the same values the line reads, part by part', () => {
    const c = loadCorpus('two-panels');
    const parts: Readout['parts'] = ['e = ', { member: 'e', digits: 3 }, ', t = ', { channel: 't', digits: 4 }, ', ', { var: 'frame' }];
    c.scene.readouts = [{ place: 'panel', parts }];
    validate(c.scene, c.data);
    const ctx = { scene: c.scene, geometry: new GeometryCache(c.scene, c.data), state: c.scene.initial, panel: 'p1', frameIndex: 3 };
    const pieces = readoutPieces(ctx, parts);
    expect(pieces).toHaveLength(parts.length);
    expect(pieces.join('')).toBe(readoutText(ctx, parts));
    expect(readoutPieces({ ...ctx, panel: 'nope' }, parts)).toEqual([]);
  });
});

describe('frame rate', () => {
  it('counts the draws presented in the last second, with the late ones and the refresh interval', () => {
    const m = new FrameMeter();
    expect(m.report(0)).toBeNull();
    const step = 1000 / 120;
    let now = 0;
    for (let i = 0; i < 130; i++) {
      now = i * step;
      m.note(now);
      if (i < 108) expect(m.report(now)).toBeNull();
    }
    const r = m.report(now)!;
    expect(r.drawn).toBe(121);
    expect(r.late).toBe(0);
    expect(r.refresh).toBeCloseTo(step);
    expect(fpsText(r)).toBe('121 fps');
    expect(fpsTitle(r)).toContain('121 frames drawn in the last second, 0 late, on a display refreshing about 120 times a second');
  });
  it('sees a dropped refresh among smooth ones, which an average would hide', () => {
    const m = new FrameMeter();
    const step = 1000 / 120;
    let now = 0;
    for (let i = 0; i < 120; i++) {
      now += i % 5 === 4 ? 2 * step : step;
      m.note(now);
    }
    const r = m.report(now)!;
    expect(r.refresh).toBeCloseTo(step);
    expect(r.late).toBeGreaterThanOrEqual(19);
    expect(r.drawn).toBeLessThan(110);
  });
  it('shows dashes while paused, before a second has passed, after a stall, and after a reset', () => {
    const m = new FrameMeter();
    expect(fpsText(null)).toBe('–– fps');
    for (let i = 0; i < 60; i++) m.note(i * 10);
    expect(m.report(590)).toBeNull();
    for (let i = 60; i < 120; i++) m.note(i * 10);
    expect(m.report(1190)).not.toBeNull();
    expect(m.report(2500)).toBeNull();
    m.reset();
    expect(m.report(1190)).toBeNull();
  });
});

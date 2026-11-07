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

describe('keys', () => {
  it('map as in common video players', () => {
    expect(keyAction(' ', false, 480)).toEqual({ kind: 'toggle' });
    expect(keyAction('k', false, 480)).toEqual({ kind: 'toggle' });
    expect(keyAction('ArrowRight', false, 480)).toEqual({ kind: 'step', by: 1 });
    expect(keyAction('ArrowLeft', true, 480)).toEqual({ kind: 'step', by: -10 });
    expect(keyAction('.', false, 480)).toEqual({ kind: 'step', by: 1 });
    expect(keyAction(',', false, 480)).toEqual({ kind: 'step', by: -1 });
    expect(keyAction('<', true, 480)).toEqual({ kind: 'step', by: -10 });
    expect(keyAction('>', true, 480)).toEqual({ kind: 'step', by: 10 });
    expect(keyAction('Home', false, 480)).toEqual({ kind: 'seek', frame: 0 });
    expect(keyAction('0', false, 480)).toEqual({ kind: 'seek', frame: 0 });
    expect(keyAction('1', false, 480)).toEqual({ kind: 'seek', frame: 48 });
    expect(keyAction('9', false, 64)).toEqual({ kind: 'seek', frame: 58 });
    expect(keyAction('f', false, 480)).toEqual({ kind: 'fit' });
    expect(keyAction('F', true, 480)).toEqual({ kind: 'fit' });
    expect(keyAction('ArrowUp', false, 480)).toEqual({ kind: 'slider', by: 1 });
    expect(keyAction('ArrowDown', true, 480)).toEqual({ kind: 'slider', by: -10 });
    expect(keyAction('x', false, 480)).toBeNull();
    expect(keyAction('End', false, 480)).toBeNull();
  });
});

describe('chrome tokens', () => {
  it('give the palette of the controls on the default theme', () => {
    const t = chromeTokens(DEFAULT_THEME);
    expect(t).toMatchObject({
      '--bg': '#000000',
      '--surface': '#0b0b0b',
      '--raised': '#272727',
      '--line': '#2b2b2b',
      '--fg': '#d8d8d8',
      '--dim': '#9a9a9a',
      '--accent': '#f0a050',
      '--accent-hover': '#ffb366',
      '--accent-press': '#d98a3a',
      '--accent-tint': '#302316',
      '--accent-2': '#c050f0',
      '--accent-2-text': '#d98cff',
      '--accent-2-tint': 'rgba(192, 80, 240, 0.16)',
      '--track': '#5c5c5c',
      '--error': '#ff7a7a',
      '--highlight': '#ffffff',
    });
  });
  it('follow a light theme, and pass only colors', () => {
    const t = chromeTokens({ background: '#ffffff', foreground: '#000000', grid: '#cccccc' });
    expect(t['--highlight']).toBe('#000000');
    expect(t['--surface']).toBe('#f2f2f2');
    const bad = chromeTokens({ background: 'red;}x{', foreground: '#000000', grid: '#cccccc' });
    for (const v of Object.values(bad)) expect(v).toMatch(/^(#[0-9a-f]{6}(cc)?|rgba\([0-9., ]+\))$/);
  });
});

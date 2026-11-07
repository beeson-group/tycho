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

/** The broucke-mini scene dressed as examples/broucke is, with controls, readouts, a colormap by eccentricity, and two panels. */
function dressedBroucke(): { scene: Scene; text: string; bytes: Uint8Array } {
  const c = loadCorpus('broucke-mini');
  const scene = structuredClone(c.scene);
  scene.title = 'Broucke families, mini';
  const tags = { family: { var: 'family' }, branch: { var: 'branch' } };
  const track = scene.views.main!.layers[0] as Extract<Scene['views'][string], object>['layers'][number] & { kind: 'track' };
  scene.views.main!.layers[0] = { ...track, color: { colormap: 'viridis', parameter: 'eccentricity' }, highlight: { var: 'e' } };
  scene.controls = [
    { kind: 'tabs', variable: 'family', label: 'family' },
    { kind: 'tabs', variable: 'branch', label: 'branch' },
    { kind: 'slider', variable: 'e', label: 'eccentricity', domain: { tags } },
    { kind: 'tabs', variable: 'frame', label: 'frame' },
    { kind: 'transport' },
  ];
  scene.readouts = [
    { place: 'caption', parts: ['e = ', { member: 'eccentricity', digits: 4 }, ', mu = ', { attr: 'mu', digits: 6 }] },
    { place: 'panel', parts: ['true anomaly = ', { channel: 'true_anomaly', digits: 3 }, ' rad'] },
  ];
  scene.initial = {
    variables: {},
    clock: { channel: 'true_anomaly' },
    panels: {
      pulsating: { view: 'main', variables: { frame: 'rotating-pulsating' } },
      inertial: { view: 'main', variables: { frame: 'barycentric-inertial' } },
    },
    layout: { kind: 'split', dir: 'row', ratio: 0.5, a: { kind: 'panel', id: 'pulsating' }, b: { kind: 'panel', id: 'inertial' } },
  };
  validate(scene, c.data);
  const bytes = new Uint8Array(readFileSync(new URL('../../spec/conformance/broucke-mini/data.tyd', import.meta.url)));
  return { scene, text: JSON.stringify(scene), bytes };
}

describe('a colorbar as a slider', () => {
  it('drives the scene-scoped selector over the parameter the layer is colored by, with the slider stops', () => {
    const { scene } = dressedBroucke();
    const view = scene.views.main!;
    const link = colorbarLink(scene, view, 'eccentricity');
    expect(link).toEqual({ variable: 'e', label: 'eccentricity', domain: (scene.controls![2] as Extract<Control, { kind: 'slider' }>).domain });
    expect(colorbarLink(scene, view, 'period')).toBeNull();
    const noSlider = { ...scene, controls: [] };
    expect(colorbarLink(noSlider, view, 'eccentricity')).toEqual({ variable: 'e', label: 'e', domain: (view.layers[0] as { sets: unknown }).sets });
    const panelScoped = structuredClone(scene);
    panelScoped.variables!.e = { ...panelScoped.variables!.e!, scope: 'panel' } as never;
    expect(colorbarLink(panelScoped, view, 'eccentricity')).toBeNull();
  });
  it('shows one bar for layers that share a scale, with the first marker and the first kernel band any of them has', () => {
    const bar = { label: 'eccentricity', gradient: 'g', stops: [], lo: 0, hi: 0.5, marker: null, band: null };
    const merged = mergeColorbars([bar, { ...bar, marker: 0.2 }, { ...bar, marker: 0.4, band: [0.3, 0.5] }, { ...bar, gradient: 'h' }]);
    expect(merged).toEqual([
      { ...bar, marker: 0.2, band: [0.3, 0.5] },
      { ...bar, gradient: 'h' },
    ]);
  });
  it('names the colormap a choice picks, falling back to the first entry', () => {
    const byFrame = { var: 'frame', map: { rotating: 'blues' as const, inertial: 'plasma' as const } };
    expect(colormapName('cividis')).toBe('cividis');
    expect(colormapName(byFrame, (v) => (v === 'frame' ? 'inertial' : undefined))).toBe('plasma');
    expect(colormapName(byFrame, () => 'other')).toBe('blues');
    expect(colormapName(byFrame)).toBe('blues');
  });
  it('picks the stop nearest the value under the pointer, clamped to the bar', () => {
    const stops = [0, 0.1, 0.25, 0.5];
    expect(stopAt(stops, 0, 0.5, 0.45)).toBe(2);
    expect(stopAt(stops, 0, 0.5, 0.1)).toBe(0);
    expect(stopAt(stops, 0, 0.5, -3)).toBe(0);
    expect(stopAt(stops, 0, 0.5, 7)).toBe(3);
    expect(stopAt([], 0, 1, 0.5)).toBe(-1);
  });
});

describe('chip menus', () => {
  const { scene } = dressedBroucke();
  const name = (id: string) => ({ pulsating: 'rotating-pulsating', inertial: 'barycentric-inertial' })[id] ?? id;
  const payload = { kind: 'value' as const, variable: 'frame', value: 'rotating' };
  it('offer Add panel, then split right, split below, and replace for every panel in layout order', () => {
    expect(chipMenu(scene.initial, name, 8).map((m) => [m.label, m.disabled, m.group])).toEqual([
      ['Add panel', false, false],
      ['Split rotating-pulsating right', false, true],
      ['Split rotating-pulsating below', false, false],
      ['Replace rotating-pulsating', false, false],
      ['Split barycentric-inertial right', false, true],
      ['Split barycentric-inertial below', false, false],
      ['Replace barycentric-inertial', false, false],
    ]);
  });
  it('number panels that share a name, and disable what would pass the limit', () => {
    const items = chipMenu(scene.initial, () => 'rotating', 2);
    expect(items.map((m) => m.label)).toContain('Replace rotating (2)');
    expect(items.filter((m) => m.disabled).map((m) => m.label)).toEqual([
      'Add panel',
      'Split rotating (1) right',
      'Split rotating (1) below',
      'Split rotating (2) right',
      'Split rotating (2) below',
    ]);
  });
  it('are state transitions, in which a split makes a panel with the value, a replace changes the target, and add splits the largest panel', () => {
    const st = scene.initial;
    const split = withPlacement(scene, st, { kind: 'drop', target: 'inertial', zone: 'bottom' }, payload, 8, () => false);
    expect(Object.keys(split.panels)).toEqual(['pulsating', 'inertial', 'p3']);
    expect(split.panels.p3!.variables!.frame).toBe('rotating');
    expect(split.layout).toEqual({
      kind: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { kind: 'panel', id: 'pulsating' },
      b: { kind: 'split', dir: 'col', ratio: 0.5, a: { kind: 'panel', id: 'inertial' }, b: { kind: 'panel', id: 'p3' } },
    });
    const replaced = withPlacement(scene, st, { kind: 'drop', target: 'pulsating', zone: 'centre' }, payload, 8, () => false);
    expect(replaced.panels.pulsating!.variables!.frame).toBe('rotating');
    expect(replaced.layout).toBe(st.layout);
    // with equal areas, the first panel in layout order counts as the largest, and it is split below when it is tall
    const added = withAdd(scene, st, payload, 8, (id) => id === 'pulsating');
    expect(added.layout.kind === 'split' && added.layout.a).toEqual({
      kind: 'split',
      dir: 'col',
      ratio: 0.5,
      a: { kind: 'panel', id: 'pulsating' },
      b: { kind: 'panel', id: 'p3' },
    });
    expect(withPlacement(scene, st, { kind: 'add' }, payload, 2, () => false)).toBe(st);
  });
});

// Tests the viewer's controls (its chrome), first the pure helpers behind them, then the shell built under Node on the DOM
// stand-in of dom-shim.ts, without a renderer, since WebGL is not available under Node.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromeTokens, colormapName, cssColorHex, DEFAULT_THEME, hostTheme, PALETTES } from '../src/runtime/colors';
import { buildChip, buildReadout, dropText, fillReadout, TychoViewerElement } from '../src/runtime/element';
import { GeometryCache } from '../src/runtime/geometry';
import { GLYPHS, icon } from '../src/runtime/icons';
import {
  colorbarLink,
  controlUsesKey,
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
import { byClass, byTag, FakeDocument, FakeElement, installDom } from './dom-shim';

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

describe('the chrome under a DOM stand-in', () => {
  let uninstall: () => void = () => undefined;
  beforeEach(() => {
    uninstall = installDom().uninstall;
  });
  afterEach(() => uninstall());

  it('draws icons as inline SVG from path strings, the Lucide ones on 24 px with a stroke and the transport ones filled on 16 px', () => {
    const house = icon('house') as unknown as FakeElement;
    expect(house.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(house.getAttribute('viewBox')).toBe('0 0 24 24');
    expect([house.getAttribute('fill'), house.getAttribute('stroke'), house.getAttribute('stroke-width')]).toEqual(['none', 'currentColor', '2']);
    expect(house.getAttribute('aria-hidden')).toBe('true');
    expect(byTag(house, 'path').map((p) => p.getAttribute('d'))).toEqual(GLYPHS.house.d);
    const play = icon('play') as unknown as FakeElement;
    expect([play.getAttribute('viewBox'), play.getAttribute('fill'), play.getAttribute('stroke')]).toEqual(['0 0 16 16', 'currentColor', 'none']);
    for (const g of Object.values(GLYPHS)) for (const d of g.d) expect(d).toMatch(/^[Mm][-0-9.,\sMmLlHhVvCcSsQqTtAaZz]+$/);
  });

  it('builds a chip, a readout as tiles or a line, and names a drop', () => {
    const chip = buildChip('rotating', 'menu');
    const root = chip.root as unknown as FakeElement;
    expect(root.textContent).toBe('rotating');
    expect(byClass(root, 'grip')).toHaveLength(1);
    expect(chip.button!.getAttribute('aria-haspopup')).toBe('menu');
    expect(chip.button!.getAttribute('aria-expanded')).toBe('false');
    expect(buildChip('x', 'select').select).not.toBeNull();
    expect(buildChip('x', 'none').button).toBeNull();

    const tiles = buildReadout(BROUCKE_CAPTION, 'wide');
    const dts = byTag(tiles.root as unknown as FakeElement, 'dt').map((d) => d.textContent);
    expect(dts).toEqual(['e', 'period', 'closure error', 'mu']);
    fillReadout(tiles, ['e = ', '0.3000', ', period ', '6.2832', ' rad, closure error ', '9.4e−13', ' DU, mu = ', '0.0121550']);
    expect(tiles.values.map((b) => b.textContent)).toEqual(['0.3000', '6.2832', '9.4e−13', '0.0121550']);
    expect(byClass(tiles.root as unknown as FakeElement, 'u').map((u) => u.textContent)).toEqual(['rad', 'DU']);
    expect(tiles.values[0]!.style.minWidth).toBeUndefined();
    fillReadout(tiles, { error: 'no set matches' });
    expect([tiles.list!.hidden, tiles.line.hidden, tiles.line.textContent]).toEqual([true, false, 'no set matches']);

    const line = buildReadout(['frame ', { clock: 'index' }, ' of ', { clock: 'steps' }], 'wide');
    expect(line.list).toBeNull();
    fillReadout(line, ['frame ', '3', ' of ', '64']);
    expect(line.line.textContent).toBe('frame 3 of 64');

    expect([
      dropText({ kind: 'value' }, 'right'),
      dropText({ kind: 'view' }, 'centre'),
      dropText({ kind: 'panel' }, 'centre'),
      dropText({ kind: 'panel' }, 'bottom'),
    ]).toEqual(['split right', 'replace', 'swap', 'move below']);
  });

  it('builds the shell of a scene: top bar, Add panel group, panel headers, stat tiles, capsules, and the export disclosure', async () => {
    const g = globalThis as Record<string, unknown>;
    g.VideoEncoder = class {};
    g.VideoFrame = class {};
    try {
      const { scene, text, bytes } = dressedBroucke();
      const doc = g.document as { activeElement: unknown };
      const hostEvents = new FakeElement(g.document as never, 'tycho-viewer');
      const v = new TychoViewerElement() as any;
      Object.assign(v, {
        shadowRoot: null,
        isConnected: false,
        style: hostEvents.style,
        hasAttribute: () => false,
        getAttribute: () => null,
        addEventListener: hostEvents.addEventListener.bind(hostEvents),
        attachShadow: () => {
          const r = new FakeElement(g.document as never, '#shadow-root');
          Object.defineProperty(r, 'activeElement', { get: () => doc.activeElement });
          v.shadowRoot = r;
          return r;
        },
      });
      await v.load(text, bytes);
      // the next two lines do what start() does once a renderer exists
      v.unsubscribe = v.store.subscribe((c: string) => v.onChange(c));
      v.onChange('state');
      const shadow = v.shadowRoot as FakeElement;
      const root = byClass(shadow, 'root')[0]!;
      const one = (cls: string, under: FakeElement = root) => {
        const found = byClass(under, cls);
        expect(found, cls).toHaveLength(1);
        return found[0]!;
      };
      expect(hostEvents.style['--accent']).toBe('#f0a050');

      // the top bar holds the title, the scene variables as label and control, then Add panel
      const header = byTag(root, 'header')[0]!;
      expect(header.childNodes.map((c) => (c.tagName === 'H1' ? 'h1' : c.className))).toEqual(['h1', 'vars', 'add']);
      expect(byTag(header, 'h1')[0]!.textContent).toBe('Broucke families, mini');
      const vars = one('vars');
      expect(vars.getAttribute('aria-label')).toBe('Scene');
      expect(byClass(vars, 'field').map((f) => byClass(f, 'k')[0]!.textContent)).toEqual(['family', 'branch', 'eccentricity']);
      const add = one('add');
      expect(add.getAttribute('aria-label')).toBe('Add panel');
      expect(byClass(add, 'k')[0]!.textContent).toBe('Add panel');
      const chips = byClass(add, 'chip');
      expect(chips.map((c) => byClass(c, 'lbl')[0]!.textContent)).toEqual([
        'rotating-pulsating',
        'rotating',
        'barycentric-inertial',
        'inertial-m1',
        'inertial-m2',
      ]);
      expect(
        chips.every((c) => byClass(c, 'body')[0]!.getAttribute('role') === 'button' && byClass(c, 'caret')[0]!.getAttribute('aria-haspopup') === 'menu'),
      ).toBe(true);

      // a panel header holds the frame chip with its value list over the caret, reset view, and close, and it does not show a title when the scene has one view
      const panels = byClass(root, 'panel');
      expect(panels.map((p) => p.dataset.id)).toEqual(['pulsating', 'inertial']);
      const head = one('phead', panels[0]);
      expect(one('t', head).hidden).toBe(true);
      const hchip = one('chip', head);
      expect(one('lbl', hchip).textContent).toBe('rotating-pulsating');
      const select = byTag(hchip, 'select')[0]!;
      expect([select.getAttribute('aria-label'), select.value, select.options.length]).toEqual(['frame', 'rotating-pulsating', 5]);
      expect(byClass(head, 'icon').map((b) => b.getAttribute('aria-label'))).toEqual(['Reset view', 'Close panel']);
      expect(byClass(head, 'seg')).toHaveLength(0);
      select.value = 'inertial-m1';
      select.dispatchEvent({ type: 'change' });
      expect(v.state.panels.pulsating.variables.frame).toBe('inertial-m1');
      expect(one('lbl', hchip).textContent).toBe('inertial-m1');
      const preadout = one('stack', panels[0]);
      expect(byTag(preadout, 'dt').map((d) => d.textContent)).toEqual(['true anomaly']);
      expect(one('u', preadout).textContent).toBe('rad');

      // the caption shows as stat tiles, with the constant last
      const stats = one('stats');
      expect(byTag(stats, 'dt').map((d) => d.textContent)).toEqual(['e', 'mu']);
      fillReadout(v.captions[0], v.pieces('pulsating', v.captions[0].parts));
      expect(byTag(stats, 'b').map((b) => b.textContent)).toEqual([
        formatNumber(Number(byTag(stats, 'b')[0]!.textContent.replace('−', '-')), 4),
        formatNumber(0.012155, 6),
      ]);

      // the footer holds the Playback, View, and Export capsules and does not have step buttons. the frame-rate counter shows dashes while paused
      const caps = byClass(root, 'cap');
      expect(caps.map((c) => c.getAttribute('aria-label'))).toEqual(['Playback', 'View', 'Export']);
      const play = one('play', caps[0]);
      expect(play.getAttribute('aria-label')).toBe('Play (k)');
      expect(byTag(caps[0]!, 'input').map((i) => i.type)).toEqual(['range']);
      expect(one('fps', caps[0]).textContent).toBe('–– fps');
      // the frame counter reserves "dd / dd" for 64 steps, so that its width stays the same once the index reaches two digits
      expect([scene.clock.steps, one('frame', caps[0]).style.minWidth]).toEqual([64, '7ch']);
      expect(byTag(caps[0]!, 'button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Play (k)', 'true_anomaly', 'time', '@index']);
      expect(byTag(caps[1]!, 'button').map((b) => b.getAttribute('aria-label'))).toEqual(['Reset every view', 'Reset scene']);
      expect(byClass(caps[1]!, 'i-house')).toHaveLength(1);

      // k plays, a digit seeks to as many tenths of the loop, and Shift with the right arrow steps ten frames and pauses
      const key = (k: string, shiftKey = false) =>
        v.onKey({ key: k, shiftKey, metaKey: false, ctrlKey: false, altKey: false, preventDefault() {}, stopPropagation() {}, composedPath: () => [v] });
      key('k');
      expect(v.store.playing).toBe(true);
      expect([play.getAttribute('aria-label'), play.classList.contains('on'), byClass(play, 'i-pause').length]).toEqual(['Pause (k)', true, 1]);
      key('5');
      expect(v.store.frame).toBe(32);
      key('ArrowRight', true);
      expect([v.store.frame, v.store.playing]).toEqual([42, false]);
      expect(one('fps', caps[0]).textContent).toBe('–– fps');

      // the export controls sit behind a disclosure that keeps its label and closes by its x button or by Esc
      const disclose = one('disclose', caps[2]);
      const bar = one('exportbar');
      expect([disclose.textContent, disclose.getAttribute('aria-expanded'), disclose.getAttribute('aria-controls'), bar.id, bar.hidden]).toEqual([
        'Export video',
        'false',
        'xbar',
        'xbar',
        true,
      ]);
      disclose.click();
      expect([disclose.textContent, disclose.getAttribute('aria-expanded'), bar.hidden]).toEqual(['Export video', 'true', false]);
      // the export opens at one loop and the highest rate that fits, and both are chosen again after a change of speed
      const [fpsSelect, loopsSelect] = byTag(bar, 'select').filter((s) => ['Frame rate', 'Loops'].includes(s.getAttribute('aria-label')!));
      expect([fpsSelect!.value, loopsSelect!.value]).toEqual(['60', '1']);
      expect(one('info', bar).textContent).toMatch(/^480 frames, 8\.0 s at 1× speed$/);
      fpsSelect!.value = '24';
      loopsSelect!.value = '3';
      const speedSelect = byTag(caps[0]!, 'select').find((s) => s.getAttribute('aria-label') === 'Playback speed')!;
      speedSelect.value = '4';
      speedSelect.dispatchEvent({ type: 'change' });
      expect([fpsSelect!.value, loopsSelect!.value, one('info', bar).textContent]).toEqual(['60', '1', '120 frames, 2.0 s at 4× speed']);
      speedSelect.value = '1';
      speedSelect.dispatchEvent({ type: 'change' });
      byClass(bar, 'icon')
        .find((b) => b.getAttribute('aria-label') === 'Close export options')!
        .click();
      expect([disclose.getAttribute('aria-expanded'), bar.hidden]).toEqual(['false', true]);
      disclose.click();
      key('Escape');
      expect([disclose.getAttribute('aria-expanded'), bar.hidden]).toEqual(['false', true]);

      // a bar chip's caret opens the placement menu, whose items are the keyboard route to a drop
      const caret = one('caret', chips[1]);
      caret.click();
      const menu = one('menu');
      expect(caret.getAttribute('aria-expanded')).toBe('true');
      const items = byTag(menu, 'button');
      expect(items.map((b) => b.textContent)).toEqual([
        'Add panel',
        'Split inertial-m1 right',
        'Split inertial-m1 below',
        'Replace inertial-m1',
        'Split barycentric-inertial right',
        'Split barycentric-inertial below',
        'Replace barycentric-inertial',
      ]);
      expect(items.every((b) => b.getAttribute('role') === 'menuitem')).toBe(true);
      items[5]!.click();
      expect(byClass(root, 'menu')).toHaveLength(0);
      expect(caret.getAttribute('aria-expanded')).toBe('false');
      const st = v.state as State;
      expect(Object.keys(st.panels).sort()).toEqual(['inertial', 'p3', 'pulsating']);
      expect(st.panels.p3!.variables!.frame).toBe('rotating');
      caret.click();
      key('Escape');
      expect(byClass(root, 'menu')).toHaveLength(0);

      // on a narrow bar the chips would wrap, hence one Add panel menu button stands in for them
      const addChips = byClass(add, 'chip');
      addChips[addChips.length - 1]!.offsetTop = 30;
      addChips[0]!.offsetHeight = 24;
      v.fitAddGroup();
      const fallback = byTag(add, 'button').find((b) => b.className === 'btn')!;
      expect([one('chips', add).hidden, fallback.hidden, fallback.textContent]).toEqual([true, false, 'Add panel']);
      fallback.click();
      expect(byTag(one('menu'), 'button').map((b) => b.textContent)).toEqual([
        'rotating-pulsating',
        'rotating',
        'barycentric-inertial',
        'inertial-m1',
        'inertial-m2',
      ]);
      byTag(one('menu'), 'button')[4]!.click();
      expect(Object.keys((v.state as State).panels)).toHaveLength(4);

      // dragging a colorbar keyed on eccentricity, or using the keyboard on it, sets the scene-scoped eccentricity selector `e`
      const bars: Colorbar[] = [{ label: 'eccentricity', gradient: 'linear-gradient(red, blue)', stops: [], lo: 0, hi: 1, marker: 0.5, band: [0.4, 0.65] }];
      v.renderer = { colorbars: () => bars, refit() {}, refitAll() {}, bind() {}, dispose() {} };
      const dom = v.panelDom.get('pulsating');
      v.syncBars('pulsating', dom);
      const grad = one('cbar-g', panels[0]);
      expect([grad.classList.contains('live'), grad.getAttribute('role'), grad.getAttribute('aria-label')]).toEqual([true, 'slider', 'eccentricity']);
      // the ends of the bar are written as integers when both are integers, as for an iterate count, and to three significant digits otherwise
      const ticks = one('cbar-n', panels[0]);
      expect(ticks.children.map((c: FakeElement) => c.textContent)).toEqual(['1', '0']);
      bars[0]!.hi = 0.9;
      v.syncBars('pulsating', dom);
      expect(ticks.children.map((c: FakeElement) => c.textContent)).toEqual(['0.900', '0.00']);
      bars[0]!.hi = 1;
      v.syncBars('pulsating', dom);
      // the kernel's band is shaded over the bar, and the marker sits above it
      const band = one('cbar-k', grad);
      expect(grad.children.map((c: FakeElement) => c.tagName.toLowerCase())).toEqual(['span', 'i']);
      expect([band.hidden, band.style.bottom, band.style.height]).toEqual([false, '40.00%', '25.00%']);
      bars[0]!.band = null;
      v.syncBars('pulsating', dom);
      expect(band.hidden).toBe(true);
      bars[0]!.band = [0, 0.1];
      v.syncBars('pulsating', dom);
      expect([band.hidden, band.style.bottom, band.style.height]).toEqual([false, '0.00%', '10.00%']);
      const pstate = v.state as State;
      const stops = sliderStops(
        { scene, state: pstate, panel: pstate.panels.pulsating! },
        v.geometry.sets,
        scene.controls![2] as Extract<Control, { kind: 'slider' }>,
      );
      expect(stops.length).toBeGreaterThan(1);
      v.setFromBar('pulsating', dom.barDom[0], 1);
      expect((v.state as State).variables!.e).toBe(stops[stops.length - 1]);
      grad.dispatchEvent({ type: 'keydown', key: 'ArrowDown' });
      expect((v.state as State).variables!.e).toBe(stops[stops.length - 2]);
      grad.dispatchEvent({ type: 'keydown', key: 'Home' });
      expect((v.state as State).variables!.e).toBe(stops[0]);
      bars[0]!.label = 'something else';
      v.syncBars('pulsating', dom);
      expect([grad.classList.contains('live'), grad.getAttribute('role')]).toEqual([false, null]);
      v.stop();
    } finally {
      delete g.VideoEncoder;
      delete g.VideoFrame;
    }
  });
});

// every node the shell builds is an element. scene strings thus reach the DOM as text and never as markup
describe('a viewer embedded on a page, under a DOM stand-in', () => {
  const g = globalThis as Record<string, unknown>;
  let doc: FakeDocument;
  let uninstall: () => void;
  beforeEach(() => {
    ({ doc, uninstall } = installDom() as { doc: FakeDocument; uninstall: () => void });
  });
  afterEach(() => {
    delete g.getComputedStyle;
    vi.unstubAllGlobals();
    uninstall();
  });

  const base64 = (bytes: Uint8Array | string) => Buffer.from(bytes).toString('base64');

  function block(attributes: Record<string, string>, payload: Uint8Array | string): FakeElement {
    const b = new FakeElement(doc as never, 'script');
    for (const [k, v] of Object.entries(attributes)) b.setAttribute(k, v);
    b.textContent = base64(payload);
    return b;
  }

  /** A viewer on the stand-in, without a renderer. `connected` stays false, hence start() leaves the canvas out. */
  function viewer(attributes: Record<string, string> = {}, children: FakeElement[] = []) {
    const host = new FakeElement(doc as never, 'tycho-viewer');
    for (const [k, v] of Object.entries(attributes)) host.setAttribute(k, v);
    host.append(...children);
    const v = new TychoViewerElement() as any;
    Object.assign(v, {
      shadowRoot: null,
      isConnected: false,
      style: host.style,
      children: host.children,
      hasAttribute: (k: string) => host.hasAttribute(k),
      getAttribute: (k: string) => host.getAttribute(k),
      addEventListener: host.addEventListener.bind(host),
      getRootNode: () => doc,
      attachShadow: () => {
        v.shadowRoot = new FakeElement(doc as never, '#shadow-root');
        return v.shadowRoot;
      },
    });
    return { v, host };
  }

  /** A loaded viewer with a stand-in for its renderer and the subscription that start() makes. */
  async function live(attributes: Record<string, string> = {}) {
    const { text, bytes } = dressedBroucke();
    const { v, host } = viewer(attributes);
    await v.load(text, bytes);
    v.unsubscribe = v.store.subscribe((c: string) => v.onChange(c));
    v.onChange('state');
    v.renderer = { setTheme: vi.fn(), renderAt: () => new Map(), refitAll: () => undefined };
    v.syncShown();
    return { v, host };
  }

  const titled = (title: string) => JSON.stringify({ ...dressedBroucke().scene, title });
  const titleOf = (v: { titleEl: { textContent: string } }) => v.titleEl.textContent;
  const loaded = (v: { scene: unknown }) => vi.waitFor(() => expect(v.scene).not.toBeNull());

  describe('theme', () => {
    it('takes a palette in place of the scene theme, and a custom property of the host over both', () => {
      const none = () => '';
      const scene = { background: '#102030', foreground: '#405060', grid: '#708090' };
      expect(hostTheme(scene, null, none)).toEqual(scene);
      expect(hostTheme(scene, 'sepia', none)).toEqual(scene);
      expect(hostTheme(scene, 'dark', none)).toEqual({ background: '#050505', foreground: '#f2f2ef', grid: '#232320' });
      expect(hostTheme(scene, 'light', none)).toEqual({ background: '#faf8f3', foreground: '#141413', grid: '#e3e0d8' });
      const set = (p: string) => (p === '--tycho-grid' ? ' #ABC ' : '');
      expect(hostTheme(scene, 'light', set)).toEqual({ ...PALETTES.light, grid: '#aabbcc' });
      expect(hostTheme(scene, null, set)).toEqual({ ...scene, grid: '#aabbcc' });
    });
    it('reads a form of a color it cannot parse only through a canvas, and ignores what is not a color', () => {
      expect(cssColorHex('#AbCdEf')).toBe('#abcdef');
      expect(cssColorHex('')).toBeNull();
      expect(cssColorHex('rgb(1, 2, 3)')).toBeNull();
    });
    it('recolors a live viewer when the attribute changes, without loading the scene again', async () => {
      const { v, host } = await live();
      const { scene, geometry, store } = v;
      expect(host.style['--bg']).toBe(sceneThemeBackground(scene));
      const accent = host.style['--accent'];
      host.setAttribute('theme', 'light');
      v.attributeChangedCallback();
      expect(v.renderer.setTheme).toHaveBeenLastCalledWith(PALETTES.light);
      expect(host.style['--bg']).toBe('#faf8f3');
      expect(host.style['--fg']).toBe('#141413');
      expect(host.style['--highlight']).toBe('#000000');
      expect(host.style['--accent']).toBe(accent);
      expect(v.dirty).toBe(true);
      host.setAttribute('theme', 'dark');
      v.attributeChangedCallback();
      expect(host.style['--bg']).toBe('#050505');
      host.removeAttribute('theme');
      v.attributeChangedCallback();
      expect(host.style['--bg']).toBe(sceneThemeBackground(scene));
      expect([v.scene, v.geometry, v.store]).toEqual([scene, geometry, store]);
      expect(v.geometry).toBe(geometry);
    });
    it('lets the custom properties of the host win, read when the attribute changes', async () => {
      const { v, host } = await live({ theme: 'dark' });
      g.getComputedStyle = () => ({ getPropertyValue: (p: string) => (p === '--tycho-background' ? '#123456' : '') });
      host.setAttribute('theme', 'light');
      v.attributeChangedCallback();
      expect(host.style['--bg']).toBe('#123456');
      expect(host.style['--fg']).toBe('#141413');
    });
    it('observes the attribute and does not need a scene to be set', () => {
      expect(TychoViewerElement.observedAttributes).toEqual(['theme']);
      expect(() => viewer({ theme: 'dark' }).v.attributeChangedCallback()).not.toThrow();
    });
  });

  describe('loading', () => {
    it('gives two viewers on one page the scene and the data of their own blocks', async () => {
      const { bytes } = dressedBroucke();
      const own = (title: string) => [block({ 'data-tycho': 'scene' }, titled(title)), block({ 'data-tycho': 'data' }, bytes)];
      const a = viewer({}, own('first')).v;
      const b = viewer({}, own('second')).v;
      a.connectedCallback();
      b.connectedCallback();
      await Promise.all([loaded(a), loaded(b)]);
      expect([titleOf(a), titleOf(b)]).toEqual(['first', 'second']);
    });
    it('prefers its own blocks to the attributes and to the blocks of an older page', async () => {
      const { bytes } = dressedBroucke();
      doc.body.append(block({ id: 'tycho-scene' }, titled('page')), block({ id: 'tycho-data' }, bytes));
      const { v } = viewer({ scene: '#tycho-scene', data: '#tycho-data' }, [
        block({ 'data-tycho': 'scene' }, titled('own')),
        block({ 'data-tycho': 'data' }, bytes),
      ]);
      v.connectedCallback();
      await loaded(v);
      expect(titleOf(v)).toBe('own');
    });
    it('falls back to the blocks with the old ids, with or without the selectors that older pages hold', async () => {
      const { bytes } = dressedBroucke();
      doc.body.append(block({ id: 'tycho-scene' }, titled('old page')), block({ id: 'tycho-data' }, bytes));
      for (const attributes of [{}, { scene: '#tycho-scene', data: '#tycho-data' }] as Record<string, string>[]) {
        const { v } = viewer(attributes);
        v.connectedCallback();
        await loaded(v);
        expect(titleOf(v)).toBe('old page');
      }
    });
    it('fetches the attributes that are URLs', async () => {
      const { bytes } = dressedBroucke();
      const files: Record<string, Uint8Array> = { 'https://x.test/a.tys': new TextEncoder().encode(titled('fetched')), './a.tyd': bytes };
      const fetched = vi.fn(async (url: string) => ({ ok: true, status: 200, arrayBuffer: async () => files[url]!.slice().buffer }));
      vi.stubGlobal('fetch', fetched);
      const { v } = viewer({ scene: 'https://x.test/a.tys', data: './a.tyd' });
      v.connectedCallback();
      await loaded(v);
      expect(titleOf(v)).toBe('fetched');
      expect(fetched).toHaveBeenCalledTimes(2);
    });
    it('shows the reason when a file is missing, and stays empty for a caller of load() when the page gives neither', async () => {
      const shown = (v: { statusEl: FakeElement }) => v.statusEl.textContent;
      vi.stubGlobal('fetch', async () => ({ ok: false, status: 404 }));
      const missing = viewer({ scene: 'a.tys', data: 'a.tyd' }).v;
      missing.connectedCallback();
      await vi.waitFor(() => expect(shown(missing)).toBe('the scene did not load: a.tys answered 404'));
      const selector = viewer({ scene: '#nope', data: '#nope' }).v;
      selector.connectedCallback();
      await vi.waitFor(() => expect(shown(selector)).toContain('the scene selector #nope does not match an element'));
      const half = viewer({}, [block({ 'data-tycho': 'scene' }, titled('half'))]).v;
      half.connectedCallback();
      await vi.waitFor(() => expect(shown(half)).toContain('the data is missing'));
      const empty = viewer().v;
      empty.connectedCallback();
      await Promise.resolve();
      expect(shown(empty)).toBe('loading…');
      expect(empty.loading).toBe(false);
    });
  });

  describe('the clock', () => {
    const steps = (v: { scene: Scene }) => v.scene.clock.steps;

    it('does not draw while the element is out of the viewport or the page is hidden', async () => {
      const raf = vi.fn(() => 7);
      g.requestAnimationFrame = raf;
      const { v } = await live();
      v.play();
      expect(v.raf).toBe(7);
      v.intersecting = false;
      v.syncShown();
      expect(v.raf).toBe(0);
      raf.mockClear();
      v.invalidate();
      expect(raf).not.toHaveBeenCalled();
      v.intersecting = true;
      doc.hidden = true;
      v.syncShown();
      v.invalidate();
      expect(raf).not.toHaveBeenCalled();
      doc.hidden = false;
      v.syncShown();
      expect(raf).toHaveBeenCalledTimes(1);
    });
    it('resumes from where it paused, however long the element was away', async () => {
      const { v } = await live();
      v.play();
      v.playProgress = 0.25;
      v.intersecting = false;
      v.syncShown();
      expect(v.playing).toBe(true);
      const before = performance.now();
      v.intersecting = true;
      v.syncShown();
      expect(v.anchor.index).toBeCloseTo(0.25 * steps(v));
      expect(v.anchor.time).toBeGreaterThanOrEqual(before);
    });
    it('resumes from a frame sought while away, rather than from the progress before it', async () => {
      const { v } = await live();
      v.play();
      v.playProgress = 0.25;
      v.intersecting = false;
      v.syncShown();
      v.seek(5);
      v.intersecting = true;
      v.syncShown();
      expect(v.anchor.index).toBe(5);
    });
    it('plays on load with autoplay, and not without it', async () => {
      expect((await live({ autoplay: '' })).v.playing).toBe(true);
      expect((await live()).v.playing).toBe(false);
    });
    it('does not autoplay under reduced motion, keeps the first frame, and still plays on request', async () => {
      (window as unknown as Record<string, unknown>).matchMedia = (q: string) => ({ matches: q === '(prefers-reduced-motion: reduce)' });
      for (const attributes of [{ autoplay: '' }, { kiosk: '' }] as Record<string, string>[]) {
        const { v } = await live(attributes);
        expect(v.playing).toBe(false);
        expect(v.store.frame).toBe(0);
        v.play();
        expect(v.playing).toBe(true);
        v.pause();
        expect(v.playing).toBe(false);
      }
    });
    it('reports false before a scene loads', () => {
      expect(viewer().v.playing).toBe(false);
    });
    it('carries the class lean with the attribute, and keeps the scrubber and the speed menu, which a script of a page may set', async () => {
      const { v } = await live({ lean: '' });
      expect(v.root.className).toBe('root lean');
      expect(byClass(v.footer as unknown as FakeElement, 'scrub')).toHaveLength(1);
      expect(byClass(v.footer as unknown as FakeElement, 'speed')).toHaveLength(1);
      expect((await live()).v.root.className).toBe('root');
    });
    it('keeps the Add panel group and the icons of the panel heads under lean="panels", for a slide on which panels are added by hand', async () => {
      expect((await live({ lean: 'panels' })).v.root.className).toBe('root lean keep-panels');
      expect((await live({ lean: 'controls' })).v.root.className).toBe('root lean');
    });
    it('links a colorbar to its selector in kiosk mode too, so that a click on the bar of a kiosk page sets the eccentricity', async () => {
      const { v } = await live({ kiosk: '' });
      const bars: Colorbar[] = [{ label: 'eccentricity', gradient: 'linear-gradient(red, blue)', stops: [], lo: 0, hi: 1, marker: 0.5, band: null }];
      v.renderer = { ...v.renderer, colorbars: () => bars };
      const dom = v.panelDom.get('pulsating');
      v.syncBars('pulsating', dom);
      const grad = dom.barDom[0].grad;
      expect([grad.classList.contains('live'), grad.getAttribute('role'), grad.getAttribute('aria-label')]).toEqual([true, 'slider', 'eccentricity']);
    });
  });

  describe('keys', () => {
    const press = (host: FakeElement, key: string, target: unknown = host, more: object = {}) => {
      const stopPropagation = vi.fn();
      const preventDefault = vi.fn();
      host.dispatchEvent({ type: 'keydown', key, stopPropagation, preventDefault, composedPath: () => [target], ...more });
      return { stopped: stopPropagation.mock.calls.length > 0, prevented: preventDefault.mock.calls.length > 0 };
    };

    it('do nothing when they are typed elsewhere on the page, since the viewer does not listen there', async () => {
      const onWindow = vi.spyOn(window, 'addEventListener');
      const { v } = await live();
      expect(doc.listening).not.toContain('keydown');
      expect(onWindow.mock.calls.map((c) => c[0])).not.toContain('keydown');
      const elsewhere = new FakeElement(doc as never, 'input');
      doc.body.appendChild(elsewhere);
      elsewhere.dispatchEvent({ type: 'keydown', key: 'k' });
      expect(v.playing).toBe(false);
    });
    it('that the viewer uses do not reach the page, and the other keys do', async () => {
      const { v, host } = await live();
      expect(press(host, 'k')).toEqual({ stopped: true, prevented: true });
      expect(v.playing).toBe(true);
      expect(press(host, ' ').stopped).toBe(true);
      expect(v.playing).toBe(false);
      expect(press(host, 'ArrowRight').stopped).toBe(true);
      expect(v.store.frame).toBe(1);
      expect(press(host, 'f').stopped).toBe(true);
      expect(press(host, 'ArrowUp').stopped).toBe(true);
      for (const key of ['n', 'b', 'Escape', 'PageDown', 'Tab']) expect(press(host, key), key).toEqual({ stopped: false, prevented: false });
      expect(press(host, 'k', host, { metaKey: true }).stopped).toBe(false);
    });
    it('reach the page when the scene gives the key nothing to do', async () => {
      const { text, bytes } = dressedBroucke();
      const scene = { ...JSON.parse(text), controls: [] };
      const { v, host } = viewer();
      await v.load(JSON.stringify(scene), bytes);
      for (const key of ['ArrowUp', 'ArrowRight', ' ']) expect(press(host, key).stopped, key).toBe(false);
      expect(press(host, 'f').stopped).toBe(true);
    });
    it('that a focused control takes do not reach the page, and the viewer acts on the others, so that 0 rewinds after a click on a tab', async () => {
      const { v, host } = await live();
      const range = new FakeElement(doc as never, 'input');
      range.type = 'range';
      expect(press(host, 'ArrowRight', range)).toEqual({ stopped: true, prevented: false });
      expect(v.store.frame).toBe(0);
      const button = new FakeElement(doc as never, 'button');
      expect(press(host, ' ', button)).toEqual({ stopped: true, prevented: false });
      expect(press(host, 'Enter', button).stopped).toBe(true);
      expect(v.playing).toBe(false);
      // a tab of a control is a button, and a key that a button does not take acts on the viewer
      expect(press(host, 'k', button)).toEqual({ stopped: true, prevented: true });
      expect(v.playing).toBe(true);
      press(host, 'k', button);
      expect(v.playing).toBe(false);
      v.store.setFrame(5);
      expect(press(host, '0', button)).toEqual({ stopped: true, prevented: true });
      expect(v.store.frame).toBe(0);
      expect(press(host, 'n', button).stopped).toBe(false);
    });
    it('know what each form control takes', () => {
      expect(controlUsesKey('INPUT', 'range', 'PageUp')).toBe(true);
      expect(controlUsesKey('INPUT', 'range', 'n')).toBe(false);
      expect(controlUsesKey('INPUT', 'checkbox', ' ')).toBe(true);
      expect(controlUsesKey('INPUT', 'checkbox', 'ArrowLeft')).toBe(false);
      expect(controlUsesKey('INPUT', 'number', 'n')).toBe(true);
      expect(controlUsesKey('SELECT', 'select-one', 'n')).toBe(true);
      expect(controlUsesKey('SELECT', 'select-one', 'Tab')).toBe(false);
      expect(controlUsesKey('TEXTAREA', 'textarea', 'n')).toBe(true);
    });
    it('reach a focusable element that does not take focus on load, and that keeps a tabindex of the page', async () => {
      const { v } = await live();
      expect(v.tabIndex).toBe(0);
      expect(doc.activeElement).toBeNull();
      const kept = viewer({ tabindex: '-1' }).v;
      kept.connectedCallback();
      expect(kept.tabIndex).toBeUndefined();
    });
  });

  it('inherits the font of the host in the chrome, with a fixed size for legibility', () => {
    const css = readFileSync(new URL('../src/runtime/element.ts', import.meta.url), 'utf8');
    expect(css).toMatch(/:host \{[^}]*font-family: inherit;[^}]*font-size: 13px;/);
    expect(css).toMatch(/:host \{[^}]*text-align: left;/);
    expect(css).not.toMatch(/ui-monospace|Helvetica/);
  });
});

/** The background of the chrome for a scene without a `theme` attribute. */
function sceneThemeBackground(scene: Scene): string {
  return chromeTokens({ ...DEFAULT_THEME, ...(scene.theme ?? {}) })['--bg']!;
}

it('the runtime does not use innerHTML', () => {
  for (const f of ['element.ts', 'icons.ts', 'readouts.ts', 'state.ts', 'colors.ts']) {
    expect(readFileSync(new URL(`../src/runtime/${f}`, import.meta.url), 'utf8')).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
  }
});

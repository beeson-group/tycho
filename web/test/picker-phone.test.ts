// Tests in a headless Google Chrome that the pole-zero pad can be used on a phone, upright and on its side, i.e. that the pad stays
// inside the panel area, that its toggle can be reached and opens and collapses it, and that its buttons are large enough for a finger.
// The page shows the corpus scene complex-domains with a points_2d control and the f(t) strip, which is the tallest pad. The test runs
// where Chrome is found, and fails in CI when it is not.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Container } from '../src/container';
import type { Scene } from '../src/scene';
import { validate } from '../src/validate';
import { Chrome, findChrome } from './chrome-driver';

const root = fileURLToPath(new URL('../..', import.meta.url));
const chromePath = findChrome();
if (chromePath === null && process.env.CI) throw new Error('the picker test needs Google Chrome, which CI provides at /usr/bin/google-chrome');

/** A box in CSS pixels of the page. */
interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
interface Pad {
  coarse: boolean;
  collapsed: boolean;
  area: Box;
  pad: Box;
  toggle: Box;
  /** Whether the point in the middle of the toggle belongs to the toggle, hence a tap there reaches it. */
  toggleOnTop: boolean;
  /** The buttons and the checkboxes with their labels, each after the body of the pad was scrolled to it. */
  controls: { name: string; box: Box; onTop: boolean }[];
  /** The canvas of the pad, after the body of the pad was scrolled to it. */
  canvas: Box;
}

const TOUCH = 36;
const inside = (a: Box, b: Box): boolean => a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5;

describe.skipIf(chromePath === null)('the pole-zero pad', () => {
  let chrome: Chrome;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tycho-picker-'));
    await build({
      entryPoints: [join(root, 'web/src/index.ts')],
      bundle: true,
      format: 'iife',
      globalName: 'tycho',
      outfile: join(dir, 'tycho.js'),
      logLevel: 'error',
    });
    const corpus = join(root, 'spec/conformance/complex-domains');
    const data = new Uint8Array(readFileSync(join(corpus, 'data.tyd')));
    const scene = JSON.parse(readFileSync(join(corpus, 'scene.tys'), 'utf-8')) as Scene;
    scene.controls = [
      {
        kind: 'points_2d',
        input: 'poles',
        secondary_input: 'zeros',
        gain_input: 'gain',
        period_input: 'T',
        show_time_domain: 'extra',
        label: 'Poles and zeros',
      },
      { kind: 'slider', input: 'T', label: 'T' },
      { kind: 'playback' },
    ];
    validate(scene, await Container.parse(data));
    const block = (kind: string, bytes: Uint8Array) =>
      `<script type="application/octet-stream" data-tycho="${kind}" data-encoding="base64">${Buffer.from(bytes).toString('base64')}</script>`;
    writeFileSync(
      join(dir, 'page.html'),
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
html, body { margin: 0; height: 100%; background: #000; }
tycho-viewer { display: block; width: 100%; height: 100%; }
</style><script src="tycho.js"></script></head><body>
<tycho-viewer theme="dark">${block('scene', new TextEncoder().encode(JSON.stringify(scene)))}${block('data', data)}</tycho-viewer>
</body></html>`,
    );
    chrome = await Chrome.launch(chromePath!);
  }, 60000);

  afterAll(async () => {
    await chrome?.close();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  /** Loads the page at a size of `width` by `height`, as a phone with a touch screen or as a desktop with a mouse. */
  async function open(width: number, height: number, phone: boolean): Promise<void> {
    await chrome.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: phone ? 3 : 1, mobile: phone });
    await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: phone, maxTouchPoints: 5 });
    await chrome.send('Page.navigate', { url: `file://${join(dir, 'page.html')}` });
    await chrome.evaluate(`(async () => {
      const t0 = Date.now();
      let v;
      while (!(v = document.querySelector('tycho-viewer'))?.state) {
        if (Date.now() - t0 > 20000) throw new Error('the viewer did not load');
        await new Promise((r) => setTimeout(r, 50));
      }
      await document.fonts.ready;
      for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r));
    })()`);
  }

  function pad(): Promise<Pad> {
    return chrome.evaluate(`(async () => {
      const root = document.querySelector('tycho-viewer').shadowRoot;
      const box = (e) => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
      const onTop = (e) => {
        const r = e.getBoundingClientRect();
        const hit = root.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
        return hit !== null && (e === hit || e.contains(hit));
      };
      const picker = root.querySelector('.picker');
      const toggle = picker.querySelector('.picker-toggle');
      const controls = [];
      for (const e of picker.querySelectorAll('.pz-btn, .pz-lock, .pz-snap')) {
        if (picker.classList.contains('collapsed')) break;
        e.scrollIntoView({ block: 'nearest' });
        controls.push({ name: e.textContent, box: box(e), onTop: onTop(e) });
      }
      const canvas = picker.querySelector('.pz-canvas');
      canvas.scrollIntoView({ block: 'nearest' });
      return {
        coarse: matchMedia('(pointer: coarse)').matches,
        collapsed: picker.classList.contains('collapsed'),
        area: box(root.querySelector('.panel-area')),
        pad: box(picker),
        toggle: box(toggle),
        toggleOnTop: onTop(toggle),
        controls,
        canvas: box(canvas),
      };
    })()`);
  }

  /** Taps the middle of `box` with one finger. */
  async function tap(box: Box): Promise<void> {
    const point = { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
    await chrome.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await chrome.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await chrome.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
  }

  it.each([
    [844, 390],
    [390, 844],
  ])(
    'starts collapsed on a phone of %i by %i, and its toggle opens and collapses it inside the panel area',
    async (width, height) => {
      await open(width, height, true);
      const start = await pad();
      expect(start.coarse).toBe(true);
      const opened = await tap(start.toggle).then(pad);
      const closed = await tap(opened.toggle).then(pad);
      expect([start.collapsed, opened.collapsed, closed.collapsed]).toEqual([true, false, true]);
      for (const p of [start, opened, closed]) {
        const at = JSON.stringify(p);
        expect(inside(p.pad, p.area), at).toBe(true);
        expect(inside(p.toggle, p.area), at).toBe(true);
        expect(p.toggleOnTop, at).toBe(true);
        expect(Math.min(p.toggle.right - p.toggle.left, p.toggle.bottom - p.toggle.top), at).toBeGreaterThanOrEqual(TOUCH);
      }
    },
    60000,
  );

  it.each([
    [844, 390],
    [390, 844],
  ])(
    'shows its whole canvas on a phone of %i by %i, and brings every button and checkbox inside the panel area at a height for a finger',
    async (width, height) => {
      await open(width, height, true);
      const opened = await tap((await pad()).toggle).then(pad);
      const at = JSON.stringify(opened);
      expect(opened.collapsed, at).toBe(false);
      expect(inside(opened.canvas, opened.area), at).toBe(true);
      // the canvas keeps the proportions of its picture
      expect((opened.canvas.right - opened.canvas.left) / (opened.canvas.bottom - opened.canvas.top)).toBeCloseTo(224 / 172, 2);
      expect(opened.controls.map((c) => c.name)).toEqual(['Conjugate', 'Snap', '+Pole', '+Zero', 'Del']);
      for (const c of opened.controls) {
        expect(inside(c.box, opened.area), `${c.name} of ${at}`).toBe(true);
        expect(c.onTop, `${c.name} of ${at}`).toBe(true);
        expect(c.box.bottom - c.box.top, `${c.name} of ${at}`).toBeGreaterThanOrEqual(TOUCH);
      }
    },
    60000,
  );

  it('starts collapsed in a panel area that is shorter than the pad, where its body scrolls once it is opened', async () => {
    await open(900, 330, false);
    const start = await pad();
    expect([start.coarse, start.collapsed], JSON.stringify(start)).toEqual([false, true]);
    await chrome.evaluate(`document.querySelector('tycho-viewer').shadowRoot.querySelector('.picker-toggle').click()`);
    const opened = await pad();
    const at = JSON.stringify(opened);
    expect(opened.collapsed, at).toBe(false);
    expect(inside(opened.pad, opened.area), at).toBe(true);
    expect(inside(opened.toggle, opened.area) && opened.toggleOnTop, at).toBe(true);
    for (const c of opened.controls) expect(inside(c.box, opened.area) && c.onTop, `${c.name} of ${at}`).toBe(true);
  }, 60000);

  it('keeps its look on a desktop, where it starts open at 244 px with small buttons', async () => {
    await open(1200, 675, false);
    const p = await pad();
    const at = JSON.stringify(p);
    expect([p.coarse, p.collapsed], at).toEqual([false, false]);
    expect(inside(p.pad, p.area), at).toBe(true);
    expect([p.pad.right - p.pad.left, p.area.right - p.pad.right, p.area.bottom - p.pad.bottom], at).toEqual([244, 10, 10]);
    expect([p.canvas.right - p.canvas.left, p.canvas.bottom - p.canvas.top], at).toEqual([224, 172]);
    expect(p.toggle.bottom - p.toggle.top, at).toBeLessThan(20);
    for (const c of p.controls.filter((c) => c.name.length <= 5)) expect(c.box.bottom - c.box.top, `${c.name} of ${at}`).toBeLessThan(24);
  }, 60000);
});

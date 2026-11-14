// Tests in a headless Google Chrome that the overlay of a panel stays inside the part of the panel under its head, i.e. that the
// colorbars and the tick numbers stay below the head and inside the panel, and that the labels are kept clear of the colorbars.
// The page lays out the corpus scene broucke-mini in the five panels of the Broucke example, at the size of the README's recording,
// shorter, and at the width of a phone. The test runs where Chrome is found, and fails in CI when it is not.
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
if (chromePath === null && process.env.CI) throw new Error('the panel layout test needs Google Chrome, which CI provides at /usr/bin/google-chrome');

/** The corpus scene broucke-mini under a 2d camera with axes and a colormap, in the five panels of the Broucke example. */
async function testScene(): Promise<{ scene: Scene; data: Uint8Array }> {
  const dir = join(root, 'spec/conformance/broucke-mini');
  const scene = JSON.parse(readFileSync(join(dir, 'scene.tys'), 'utf-8')) as Scene;
  const data = new Uint8Array(readFileSync(join(dir, 'data.tyd')));
  const view = scene.panels.main!;
  view.camera = { kind: '2d', plane: 'xy' };
  const layers = view.layers;
  layers[0] = { ...layers[0]!, color: { colormap: 'viridis', parameter: 'eccentricity' }, highlight: { input: 'e' } } as (typeof layers)[0];
  layers.push({ kind: 'axes' } as (typeof layers)[0], { kind: 'grid' } as (typeof layers)[0]);
  const frames = ['rotating-pulsating', 'barycentric-inertial', 'rotating', 'inertial-m1', 'inertial-m2'];
  scene.initial.panels = Object.fromEntries(frames.map((f, i) => [`p${i}`, { panel: 'main', inputs: { frame: f } }]));
  const leaf = (i: number) => ({ kind: 'panel' as const, id: `p${i}` });
  const split = (dir: 'row' | 'col', ratio: number, a: unknown, b: unknown) => ({ kind: 'split', dir, ratio, a, b });
  scene.initial.layout = split(
    'row',
    0.6,
    split('col', 0.66, split('row', 0.5, leaf(0), leaf(1)), leaf(2)),
    split('col', 0.5, leaf(3), leaf(4)),
  ) as Scene['initial']['layout'];
  validate(scene, await Container.parse(data));
  return { scene, data };
}

/** A box in CSS pixels of the page. */
interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
interface PanelBoxes {
  panel: string;
  body: Box;
  head: Box;
  bars: Box[];
  labels: { text: string; kind: string; box: Box }[];
}

// two boxes that share less than half a pixel are taken as touching, which the rounding of a layout gives
const overlap = (a: Box, b: Box): boolean => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

describe.skipIf(chromePath === null)('the overlay of a panel', () => {
  let chrome: Chrome;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tycho-layout-'));
    await build({
      entryPoints: [join(root, 'web/src/index.ts')],
      bundle: true,
      format: 'iife',
      globalName: 'tycho',
      outfile: join(dir, 'tycho.js'),
      logLevel: 'error',
    });
    const { scene, data } = await testScene();
    const block = (kind: string, bytes: Uint8Array) =>
      `<script type="application/octet-stream" data-tycho="${kind}" data-encoding="base64">${Buffer.from(bytes).toString('base64')}</script>`;
    writeFileSync(
      join(dir, 'page.html'),
      `<!doctype html><html><head><meta charset="utf-8"><style>
html, body { margin: 0; height: 100%; background: #000; }
tycho-viewer { display: block; width: 100%; height: 100%; }
</style><script src="tycho.js"></script></head><body>
<tycho-viewer minimal theme="dark">${block('scene', new TextEncoder().encode(JSON.stringify(scene)))}${block('data', data)}</tycho-viewer>
</body></html>`,
    );
    chrome = await Chrome.launch(chromePath!);
  }, 60000);

  afterAll(() => {
    chrome?.close();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  /** The boxes of every panel's body, head, colorbars, and shown labels, on a page of `width` by `height` at frame index `index`. */
  async function boxes(width: number, height: number, index: number): Promise<PanelBoxes[]> {
    await chrome.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
    await chrome.send('Page.navigate', { url: `file://${join(dir, 'page.html')}` });
    return chrome.evaluate(`(async () => {
      const t0 = Date.now();
      let v;
      while (!(v = document.querySelector('tycho-viewer'))?.state) {
        if (Date.now() - t0 > 20000) throw new Error('the viewer did not load');
        await new Promise((r) => setTimeout(r, 50));
      }
      await document.fonts.ready;
      v.pause();
      v.seek(${index} / 64 * 8);
      for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r));
      const box = (e) => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
      return [...v.shadowRoot.querySelectorAll('.panel')].map((p, i) => ({
        panel: 'p' + i,
        body: box(p.querySelector('.pbody')),
        head: box(p.querySelector('.pheader')),
        bars: [...p.querySelectorAll('.cbar')].map(box),
        labels: [...p.querySelectorAll('.labels span')].filter((s) => !s.hidden).map((s) => ({
          text: s.textContent,
          kind: s.style.fontSize === '13px' ? 'title' : /^[−\\d.]+$/.test(s.textContent) ? 'tick' : 'body',
          box: box(s),
        })),
      }));
    })()`);
  }

  const sizes: [number, number][] = [
    [1200, 675],
    [1200, 480],
    [390, 844],
  ];

  it.each(sizes)(
    'keeps every colorbar under the head and inside the panel, at %i by %i',
    async (width, height) => {
      for (const index of [0, 16, 40]) {
        for (const p of await boxes(width, height, index)) {
          for (const b of p.bars) {
            const at = `${p.panel} at frame index ${index}: bar ${JSON.stringify(b)}, head ${JSON.stringify(p.head)}, body ${JSON.stringify(p.body)}`;
            expect(b.top, at).toBeGreaterThanOrEqual(p.head.bottom);
            expect(b.bottom, at).toBeLessThanOrEqual(p.body.bottom);
          }
        }
      }
    },
    60000,
  );

  it.each(sizes)(
    'keeps every tick number clear of the head, at %i by %i',
    async (width, height) => {
      for (const index of [0, 16, 40]) {
        for (const p of await boxes(width, height, index)) {
          for (const l of p.labels.filter((l) => l.kind === 'tick')) {
            const at = `${p.panel} at frame index ${index}: tick ${l.text} at ${JSON.stringify(l.box)}, head ${JSON.stringify(p.head)}`;
            expect(l.box.top, at).toBeGreaterThanOrEqual(p.head.bottom);
          }
        }
      }
    },
    60000,
  );

  it.each(sizes)(
    'keeps tick numbers, axis titles, and body labels clear of the colorbars, at %i by %i',
    async (width, height) => {
      for (const index of [0, 16, 40]) {
        for (const p of await boxes(width, height, index)) {
          for (const l of p.labels) {
            for (const b of p.bars) {
              const at = `${p.panel} at frame index ${index}: ${l.kind} ${l.text} at ${JSON.stringify(l.box)}, bar ${JSON.stringify(b)}`;
              expect(overlap(l.box, b), at).toBe(false);
            }
          }
        }
      }
    },
    60000,
  );
});

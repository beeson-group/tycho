// Tests that a frame of the video export of a kiosk viewer is the picture of the viewer on the page at the same time, in a headless
// Google Chrome at a device pixel ratio of 2. The test runs where Chrome is found, and fails in CI when it is not.
import { readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
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
if (chromePath === null && process.env.CI) throw new Error('the export test needs Google Chrome, which CI provides at /usr/bin/google-chrome');

/** The corpus scene broucke-mini in two panels, with a colormap, a highlight, a panel readout, and a caption readout. */
async function testScene(): Promise<{ scene: Scene; data: Uint8Array }> {
  const dir = join(root, 'spec/conformance/broucke-mini');
  const scene = JSON.parse(readFileSync(join(dir, 'scene.tys'), 'utf-8')) as Scene;
  const data = new Uint8Array(readFileSync(join(dir, 'data.tyd')));
  const layers = scene.panels.main!.layers;
  layers[0] = { ...layers[0]!, color: { colormap: 'viridis', parameter: 'eccentricity' }, highlight: { input: 'e' } } as (typeof layers)[0];
  scene.readouts = [
    { place: 'panel', parts: ['true anomaly ', { channel: 'true_anomaly', digits: 4 }] },
    { place: 'caption', parts: ['frame ', { clock: 'frame_index' }, ' of ', { clock: 'frame_count' }] },
  ];
  scene.initial.panels = { p1: { panel: 'main' }, p2: { panel: 'main', inputs: { frame: 'inertial-m1' } } };
  scene.initial.layout = { kind: 'split', dir: 'row', ratio: 0.5, a: { kind: 'panel', id: 'p1' }, b: { kind: 'panel', id: 'p2' } };
  validate(scene, await Container.parse(data));
  return { scene, data };
}

describe.skipIf(chromePath === null)('the export of a kiosk viewer', () => {
  let chrome: Chrome;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tycho-export-'));
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
html, body { margin: 0; background: #000; font: 13px Georgia, serif; }
tycho-viewer { position: absolute; left: 0; top: 0; width: 480px; height: 360px; --tycho-font: Georgia, serif; }
</style><script src="tycho.js"></script></head><body>
<tycho-viewer kiosk>${block('scene', new TextEncoder().encode(JSON.stringify(scene)))}${block('data', data)}</tycho-viewer>
</body></html>`,
    );
    // a device scale factor given at launch lays the page out as a screen of that density does, which emulation does not
    chrome = await Chrome.launch(chromePath!, ['--force-device-scale-factor=2', '--window-size=800,600']);
    await chrome.send('Page.navigate', { url: `file://${join(dir, 'page.html')}` });
    await chrome.evaluate(`new Promise((resolve, reject) => {
      const t0 = Date.now();
      const poll = () => document.querySelector('tycho-viewer')?.state ? resolve() : Date.now() - t0 > 20000 ? reject(new Error('the viewer did not load')) : setTimeout(poll, 50);
      poll();
    })`);
  }, 60000);

  afterAll(() => {
    chrome?.close();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  /** The page's picture of the viewer at frame index `index`, and frame 0 of an export started there, compared in the page. */
  async function compare(index: number): Promise<{ mean: number; far: number; width: number; height: number }> {
    await chrome.evaluate(`(async () => {
      const v = document.querySelector('tycho-viewer');
      await document.fonts.ready;
      v.pause();
      v.seek(${index} / 64 * 8);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    })()`);
    const shot = (await chrome.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 480, height: 360, scale: 1 } })) as {
      data: string;
    };
    return chrome.evaluate(`(async () => {
      const v = document.querySelector('tycho-viewer');
      const stop = new AbortController();
      let frame = null;
      await v.exportVideo({
        size: { width: 960, height: 720, pixelRatio: 2 }, start: ${index}, signal: stop.signal,
        onFrame: (f) => { frame = f.getContext('2d').getImageData(0, 0, f.width, f.height); stop.abort(); },
      }).catch((e) => { if (e.name !== 'AbortError') throw e; });
      const shot = await createImageBitmap(await (await fetch('data:image/png;base64,${shot.data}')).blob());
      const c = new OffscreenCanvas(shot.width, shot.height).getContext('2d');
      c.drawImage(shot, 0, 0);
      const a = frame.data;
      const b = c.getImageData(0, 0, shot.width, shot.height).data;
      if (a.length !== b.length) return { mean: Infinity, far: Infinity, width: shot.width, height: shot.height };
      let sum = 0, far = 0;
      for (let i = 0; i < a.length; i += 4) {
        const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
        sum += d;
        if (d > 64) far++;
      }
      return { mean: sum / (a.length / 4), far: far / (a.length / 4), width: shot.width, height: shot.height };
    })()`);
  }

  it('draws the picture of the viewer on the page, within the antialiasing of text', async () => {
    const results = [];
    for (const index of [0, 21, 50]) results.push({ index, ...(await compare(index)) });
    for (const r of results) {
      const at = `frame index ${r.index} of ${JSON.stringify(results)}`;
      expect([r.width, r.height], at).toEqual([960, 720]);
      // the mean difference of a channel, out of 255, and the share of pixels that differ by more than a quarter of the range. The
      // antialiasing of text on Linux differs at about 0.1% of the pixels, and the old drawing of the export gave a mean of 8.3
      expect(r.mean, at).toBeLessThan(0.5);
      expect(r.far, at).toBeLessThan(2e-3);
    }
  }, 60000);
});

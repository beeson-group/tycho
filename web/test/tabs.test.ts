// Tests in a headless Google Chrome that every tab of a tabs control can be reached, also on a page narrower than the tabs in one row,
// and that a row of tabs which is too wide does not widen the panels past the page. The page shows the corpus scene broucke-mini with a
// choice of seven values. The test runs where Chrome is found, and fails in CI when it is not.
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
if (chromePath === null && process.env.CI) throw new Error('the tabs test needs Google Chrome, which CI provides at /usr/bin/google-chrome');

const NAMES: [string, ...string[]] = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh'];

/** A box in CSS pixels of the page. */
interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

describe.skipIf(chromePath === null)('a row of tabs', () => {
  let chrome: Chrome;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tycho-tabs-'));
    await build({
      entryPoints: [join(root, 'web/src/index.ts')],
      bundle: true,
      format: 'iife',
      globalName: 'tycho',
      outfile: join(dir, 'tycho.js'),
      logLevel: 'error',
    });
    const corpus = join(root, 'spec/conformance/broucke-mini');
    const scene = JSON.parse(readFileSync(join(corpus, 'scene.tys'), 'utf-8')) as Scene;
    const data = new Uint8Array(readFileSync(join(corpus, 'data.tyd')));
    scene.inputs = { ...scene.inputs, line: { kind: 'choice', values: NAMES, labels: NAMES.map((n) => `${n} line`), default: 'first' } };
    scene.controls = [{ kind: 'tabs', input: 'line', label: 'line' }];
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

  afterAll(() => {
    chrome?.close();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  /** The boxes of the tabs and of the panels on a page of `width` by `height`. */
  async function boxes(width: number, height: number): Promise<{ tabs: Box[]; panels: Box[] }> {
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
      for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r));
      const box = (e) => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
      return { tabs: [...v.shadowRoot.querySelectorAll('.seg button')].map(box), panels: [...v.shadowRoot.querySelectorAll('.panel')].map(box) };
    })()`);
  }

  it.each([
    [390, 844],
    [1200, 675],
  ])(
    'keeps every tab and every panel inside the page, at %i by %i',
    async (width, height) => {
      const { tabs, panels } = await boxes(width, height);
      expect(tabs).toHaveLength(NAMES.length);
      expect(panels).toHaveLength(1);
      for (const [i, b] of [...tabs, ...panels].entries()) {
        const at = `${i < tabs.length ? `the tab ${NAMES[i]}` : 'the panel'} at ${JSON.stringify(b)}`;
        expect(b.left, at).toBeGreaterThanOrEqual(0);
        expect(b.right, at).toBeLessThanOrEqual(width);
      }
    },
    60000,
  );

  it('stays on one line on a page that is wide enough', async () => {
    const { tabs } = await boxes(1200, 675);
    expect(new Set(tabs.map((b) => b.top)).size).toBe(1);
  }, 60000);
});

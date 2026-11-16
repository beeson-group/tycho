// Tests in a headless Google Chrome that every viewer on a page with more viewers than Chrome keeps WebGL contexts, i.e. 16, draws
// its scene whenever it is scrolled into view. The page shows the corpus scene broucke-mini in 20 viewers, one below the other, at
// most one of which is fully in view. The test runs where Chrome is found, and fails in CI when it is not.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Chrome, findChrome } from './chrome-driver';

const root = fileURLToPath(new URL('../..', import.meta.url));
const chromePath = findChrome();
if (chromePath === null && process.env.CI) throw new Error('the test of many viewers needs Google Chrome, which CI provides at /usr/bin/google-chrome');

const VIEWERS = 20;
/** The size of a viewer, in CSS pixels, and the gap below it, so that a viewer scrolled to the top of the page is the only one in view. */
const W = 640;
const H = 480;
const GAP = 120;

describe.skipIf(chromePath === null)('a page with 20 viewers', () => {
  let chrome: Chrome;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tycho-viewers-'));
    await build({
      entryPoints: [join(root, 'web/src/index.ts')],
      bundle: true,
      format: 'iife',
      globalName: 'tycho',
      outfile: join(dir, 'tycho.js'),
      logLevel: 'error',
    });
    const corpus = join(root, 'spec/conformance/broucke-mini');
    const block = (kind: string, bytes: Uint8Array) =>
      `<script type="application/octet-stream" data-tycho="${kind}" data-encoding="base64">${Buffer.from(bytes).toString('base64')}</script>`;
    const viewer = `<tycho-viewer theme="dark">${block('scene', readFileSync(join(corpus, 'scene.tys')))}${block('data', readFileSync(join(corpus, 'data.tyd')))}</tycho-viewer>`;
    writeFileSync(
      join(dir, 'page.html'),
      `<!doctype html><html><head><meta charset="utf-8"><style>
html, body { margin: 0; background: #000; }
tycho-viewer { display: block; width: ${W}px; height: ${H}px; margin-bottom: ${GAP}px; }
</style><script src="tycho.js"></script></head><body>
${viewer.repeat(VIEWERS)}
</body></html>`,
    );
    chrome = await Chrome.launch(chromePath!);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 800, height: H + GAP, deviceScaleFactor: 1, mobile: false });
    await chrome.send('Page.navigate', { url: `file://${join(dir, 'page.html')}` });
    await chrome.evaluate(`(async () => {
      const t0 = Date.now();
      while ([...document.querySelectorAll('tycho-viewer')].some((v) => !v.state)) {
        if (Date.now() - t0 > 30000) throw new Error('the viewers did not load');
        await new Promise((r) => setTimeout(r, 50));
      }
      await document.fonts.ready;
    })()`);
  }, 90000);

  afterAll(() => {
    chrome?.close();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  /** Scrolls viewer `i` to the top of the page, and returns a screenshot of it as a PNG in base64, and whether its WebGL context is lost. */
  async function show(i: number): Promise<{ shot: string; lost: boolean }> {
    const { top, lost } = await chrome.evaluate<{ top: number; lost: boolean }>(`(async () => {
      const v = document.querySelectorAll('tycho-viewer')[${i}];
      window.scrollTo(0, v.offsetTop);
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      for (let k = 0; k < 4; k++) await frame();
      // the static layers of a panel drawn again shortly after a draw are refined 150 ms later
      await new Promise((r) => setTimeout(r, 250));
      for (let k = 0; k < 2; k++) await frame();
      return { top: window.scrollY, lost: v.shadowRoot.querySelector('canvas[data-engine]')?.getContext('webgl2')?.isContextLost() ?? true };
    })()`);
    // the clip is given in pixels of the page, not of the viewport
    const clip = { x: 0, y: top, width: W, height: H, scale: 1 };
    const { data } = (await chrome.send('Page.captureScreenshot', { format: 'png', clip })) as { data: string };
    return { shot: data, lost };
  }

  /** The fraction of the pixels of two screenshots that differ by more than 64 in a channel. */
  async function differ(a: string, b: string): Promise<number> {
    return chrome.evaluate<number>(`(async () => {
      const read = async (s) => {
        const image = await createImageBitmap(await (await fetch('data:image/png;base64,' + s)).blob());
        const g = new OffscreenCanvas(image.width, image.height).getContext('2d');
        g.drawImage(image, 0, 0);
        return g.getImageData(0, 0, image.width, image.height).data;
      };
      const [a, b] = await Promise.all([read('${a}'), read('${b}')]);
      if (a.length !== b.length) return 1;
      let far = 0;
      for (let i = 0; i < a.length; i += 4) if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > 64) far++;
      return far / (a.length / 4);
    })()`);
  }

  it('draws each viewer whenever it is scrolled into view, on the way down and back up', async () => {
    const down: { shot: string; lost: boolean }[] = [];
    for (let i = 0; i < VIEWERS; i++) down.push(await show(i));
    const up: { shot: string; lost: boolean }[] = [];
    for (let i = VIEWERS - 1; i >= 0; i--) up[i] = await show(i);
    // every viewer shows the same scene in the same state, and the last one created is never the oldest context
    const reference = down[VIEWERS - 1]!.shot;
    const wrong: string[] = [];
    for (const [pass, shows] of [
      ['down', down],
      ['up', up],
    ] as const) {
      for (const [i, s] of shows.entries()) {
        const far = await differ(s.shot, reference);
        if (s.lost || far > 0.002) wrong.push(`viewer ${i} on the way ${pass}: ${s.lost ? 'context lost, ' : ''}${(100 * far).toFixed(2)}% of pixels differ`);
      }
    }
    expect(wrong).toEqual([]);
  }, 120000);

  it('keeps the camera and the time of a viewer whose context was released while the viewer was out of view', async () => {
    const last = VIEWERS - 1;
    await show(last);
    // the last viewer is paused at 3 s of its timeline, and zoomed in at the middle of its panel
    const at = await chrome.evaluate<{ x: number; y: number }>(`(() => {
      const v = document.querySelectorAll('tycho-viewer')[${last}];
      v.seek(3);
      const r = v.shadowRoot.querySelector('.panel').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await chrome.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY: -300 });
    await chrome.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 790, y: 10 });
    const before = await show(last);
    expect(await differ(before.shot, (await show(last - 1)).shot), 'the zoom changed the picture').toBeGreaterThan(0.01);
    for (let i = last - 2; i >= 0; i--) await show(i);
    const released = await chrome.evaluate<boolean>(
      `document.querySelectorAll('tycho-viewer')[${last}].shadowRoot.querySelector('canvas[data-engine]').getContext('webgl2').isContextLost()`,
    );
    expect(released, 'the context of the last viewer was released while 19 others were shown').toBe(true);
    const after = await show(last);
    expect(after.lost).toBe(false);
    expect(await differ(after.shot, before.shot)).toBeLessThan(0.002);
    expect(await chrome.evaluate<number>(`document.querySelectorAll('tycho-viewer')[${last}].time`)).toBeCloseTo(3, 6);
  }, 120000);
});

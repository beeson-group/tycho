// Takes the poster of an example page, i.e. the still image that the docs gallery shows. The page is opened in headless Chrome
// at 1920 by 1080 CSS pixels and a pixel ratio of 1, which keeps the tick numbers of five panels legible. It is captured with
// its controls, paused at the middle of its loop in its initial state.
//   node web/scripts/poster.mjs examples/broucke/broucke.html examples/broucke/broucke.png
// Chrome is $CHROME, else the default macOS install, else google-chrome on the PATH.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [page, out] = process.argv.slice(2);
if (page === undefined || out === undefined) {
  console.error('usage: node web/scripts/poster.mjs <page.html> <poster.png>');
  process.exit(2);
}
const MAC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executable = process.env.CHROME ?? (existsSync(MAC) ? MAC : 'google-chrome');
// a fresh profile, so that a stored state cannot move the page off its initial state
const profile = mkdtempSync(join(tmpdir(), 'tycho-poster-'));
const port = 9300 + Math.floor(Math.random() * 600);
const chrome = spawn(
  executable,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const exited = new Promise((r) => chrome.once('exit', r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  let target;
  for (let i = 0; i < 100 && target === undefined; i++) {
    try {
      target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    } catch {
      await sleep(100);
    }
  }
  if (target === undefined) throw new Error(`Chrome did not start: ${executable}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let id = 0;
  const pending = new Map();
  let loaded;
  const load = new Promise((r) => (loaded = r));
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.method === 'Page.loadEventFired') loaded();
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  };
  const send = (method, params = {}) =>
    new Promise((r) => {
      pending.set(++id, r);
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: pathToFileURL(resolve(page)).href });
  await load;
  const seek = `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const v = document.querySelector('tycho-viewer');
    for (let i = 0; i < 600 && !(v?.state && v.shadowRoot?.querySelector('input.scrub')); i++) await sleep(100);
    const scrub = v.shadowRoot.querySelector('input.scrub');
    scrub.value = String(Math.floor((Number(scrub.max) + 1) / 2));
    scrub.dispatchEvent(new Event('input'));
    await sleep(1500);
    return scrub.value + ' of ' + (Number(scrub.max) + 1);
  })()`;
  const res = await send('Runtime.evaluate', { expression: seek, awaitPromise: true, returnByValue: true });
  if (res.result.exceptionDetails !== undefined) throw new Error(JSON.stringify(res.result.exceptionDetails));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log(`wrote ${out} at frame ${res.result.result.value}`);
  ws.close();
} finally {
  chrome.kill();
  await exited;
  rmSync(profile, { recursive: true, force: true });
}

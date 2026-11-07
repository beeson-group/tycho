// Measures what one playback frame of an example page costs, in headless Chrome on the GPU of this machine. The element's
// tick() itself is called at fractional progress across the loop, as in playback, and each call is timed on the CPU
// alone and with a 1x1 readPixels that waits for the GPU.
//   node web/scripts/frame-profile.mjs examples/broucke/broucke.html --set family=11 --set branch=apoapsis
// The options are --frames N (600 by default), --size WxH (1600x1000 CSS px by default), --dpr D (2 by default),
// and the repeatable --set var=value for a scene-scoped variable. The option --no-cache draws every layer every
// frame, i.e. the reference path of the renderer. With --compare-cache, the script compares frames drawn with
// and without the static-layer cache pixel by pixel, instead of timing. With --drag id:from:to, it instead times
// 240 paused frames that each move selector id across [from, to], as a slider drag does, with and without coarse
// drags. It then checks the frames drawn after the drag stops against frames drawn without the cache. The option
// --switch var=value, which can be repeated and goes with --drag, sets the variables after the drag and checks
// the frames drawn after the change. The option --json prints machine-readable output. Chrome is $CHROME, else
// the default macOS install, else google-chrome on the PATH. The numbers leave out the headed compositor, hence
// they rank costs and show regressions rather than predict the frame rate of a display.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';

const args = process.argv.slice(2);
const page = args.find((a) => !a.startsWith('--') && extname(a) === '.html');
if (page === undefined) {
  console.error('usage: node web/scripts/frame-profile.mjs <page.html> [--frames N] [--size WxH] [--dpr D] [--set var=value]... [--json]');
  process.exit(2);
}
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const frames = Number(option('--frames', '600'));
const [width, height] = option('--size', '1600x1000').split('x').map(Number);
const dpr = Number(option('--dpr', '2'));
const sets = args.flatMap((a, i) => (a === '--set' ? [args[i + 1].split('=')] : []));
const json = args.includes('--json');
const cache = !args.includes('--no-cache');
const compare = args.includes('--compare-cache');
const drag = option('--drag', null);
const switches = args.flatMap((a, i) => (a === '--switch' ? [args[i + 1].split('=')] : []));

const root = resolve('.');
const target = resolve(page);
if (!target.startsWith(root + sep)) {
  console.error(`${page} is outside the working directory ${root}, which the script serves`);
  process.exit(2);
}

// a static server over the working directory, so that the page loads from a server like a deployed one
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };
const server = createServer((req, res) => {
  const file = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root + sep) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/${target
  .slice(root.length + 1)
  .split(sep)
  .join('/')}`;

const MAC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executable = process.env.CHROME ?? (existsSync(MAC) ? MAC : 'google-chrome');
const profile = mkdtempSync(join(tmpdir(), 'tycho-profile-'));
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
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const exited = new Promise((r) => chrome.once('exit', r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a minimal client of the Chrome DevTools protocol over the WebSocket class that Node ships
async function openTab() {
  let info = null;
  for (let i = 0; i < 100 && info === null; i++) {
    await sleep(100);
    info = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
      .then((r) => r.json())
      .catch(() => null);
  }
  if (info === null) throw new Error('Chrome did not open its debugging port');
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((r, j) => {
      const i = ++id;
      pending.set(i, (msg) => (msg.error ? j(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : r(msg.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? JSON.stringify(res.exceptionDetails));
    return res.result.value;
  };
  return { send, evaluate };
}

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

// MEASURE runs in the page. It drives tick() as playback does, and times each call with and without the GPU wait.
const MEASURE = `(async (frames, sets, cache) => {
  const v = document.querySelector('tycho-viewer');
  v.renderer.cacheStatic = cache;
  const steps = v.scene.clock.steps;
  for (const [id, value] of sets) {
    const variable = v.scene.variables[id];
    const parsed = variable.kind === 'selector' ? Number(value) : variable.kind === 'toggle' ? value === 'true' : value;
    v.store.update((s) => ({ ...s, variables: { ...s.variables, [id]: parsed } }));
  }
  const glc = v.renderer.gl.getContext();
  const pixel = new Uint8Array(4);
  const laps = v.scene.clock.laps ?? 1;
  v.store.setPlaying(true);
  v.anchor = { index: 0, time: 0 };
  // at(q) is the time at which the tick lands at progress q, from the position x = now * steps * speed / (1000 * 8 * laps)
  const at = (q) => (q * 1000 * 8 * laps) / v.speed;
  const run = (n, wait) => {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const q = (i + 0.37) / n;
      const t0 = performance.now();
      v.tick(at(q));
      if (v.raf) cancelAnimationFrame(v.raf);
      v.raf = 0;
      if (wait) glc.readPixels(0, 0, 1, 1, glc.RGBA, glc.UNSIGNED_BYTE, pixel);
      out[i] = performance.now() - t0;
    }
    return Array.from(out);
  };
  run(120, true);
  const cpu = run(frames, false);
  const gpu = run(frames, true);
  v.store.setPlaying(false);
  const renderer = (() => {
    const ext = glc.getExtension('WEBGL_debug_renderer_info');
    return ext ? glc.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
  })();
  return { steps, panels: v.renderer.panels.size, cpu, gpu, renderer };
})(${frames}, ${JSON.stringify(sets)}, ${cache})`;

// DRAG runs in the page. It simulates a slider drag with one new selector value per frame, then draws the frames after it stops.
const DRAG = `(async (spec, switches) => {
  const [id, from, to] = spec.split(':');
  const v = document.querySelector('tycho-viewer');
  const R = v.renderer;
  const glc = R.gl.getContext();
  const pixel = new Uint8Array(4);
  const set = (x) => v.store.update((s) => ({ ...s, variables: { ...s.variables, [id]: x } }));
  // a paused viewer draws only after a change, hence frame() forces a draw for the comparison
  const frame = () => {
    v.dirty = true;
    v.tick(performance.now());
    if (v.raf) cancelAnimationFrame(v.raf);
    v.raf = 0;
  };
  const sweep = (coarse) => {
    R.coarseDrags = coarse;
    const out = [];
    for (let i = 0; i < 240; i++) {
      set(Number(from) + ((Number(to) - Number(from)) * (i % 120)) / 119);
      const t0 = performance.now();
      frame();
      glc.readPixels(0, 0, 1, 1, glc.RGBA, glc.UNSIGNED_BYTE, pixel);
      out.push(performance.now() - t0);
    }
    return out;
  };
  const fine = sweep(false);
  const coarse = sweep(true);
  const w = glc.drawingBufferWidth;
  const h = glc.drawingBufferHeight;
  const read = () => {
    const px = new Uint8Array(4 * w * h);
    glc.readPixels(0, 0, w, h, glc.RGBA, glc.UNSIGNED_BYTE, px);
    return px;
  };
  // check draws n frames with the cache and compares the last one with a frame drawn without it
  const check = (label, n) => {
    for (let i = 0; i < n; i++) frame();
    const cached = read();
    R.cacheStatic = false;
    frame();
    const ref = read();
    R.cacheStatic = true;
    let over32 = 0;
    for (let i = 0; i < ref.length; i++) if (Math.abs(ref[i] - cached[i]) > 32) over32++;
    return { label, over32, channels: ref.length };
  };
  const checks = [];
  // the refine comes REFINE_MS after the last coarse rebuild, as a redraw that the renderer requests
  await new Promise((r) => setTimeout(r, 400));
  checks.push(check('the refine after the drag', 1));
  checks.push(check('two frames after the refine', 2));
  if (switches.length > 0) {
    for (const [k, value] of switches) v.store.update((s) => ({ ...s, variables: { ...s.variables, [k]: value } }));
    checks.push(check('the frame of the change', 1));
    checks.push(check('three frames after the change', 3));
  }
  return { fine, coarse, checks };
})(${JSON.stringify(drag)}, ${JSON.stringify(switches)})`;

// COMPARE runs in the page. It draws each progress once without the cache and twice with it, the second
// time from the underlay, and compares the two canvases channel by channel.
const COMPARE = `(async (sets) => {
  const v = document.querySelector('tycho-viewer');
  for (const [id, value] of sets) {
    const variable = v.scene.variables[id];
    const parsed = variable.kind === 'selector' ? Number(value) : variable.kind === 'toggle' ? value === 'true' : value;
    v.store.update((s) => ({ ...s, variables: { ...s.variables, [id]: parsed } }));
  }
  const glc = v.renderer.gl.getContext();
  const w = glc.drawingBufferWidth;
  const h = glc.drawingBufferHeight;
  const laps = v.scene.clock.laps ?? 1;
  v.store.setPlaying(true);
  v.anchor = { index: 0, time: 0 };
  const at = (q) => (q * 1000 * 8 * laps) / v.speed;
  const shot = (q) => {
    v.tick(at(q));
    if (v.raf) cancelAnimationFrame(v.raf);
    v.raf = 0;
    const px = new Uint8Array(4 * w * h);
    glc.readPixels(0, 0, w, h, glc.RGBA, glc.UNSIGNED_BYTE, px);
    return px;
  };
  const out = [];
  for (const q of [0.0, 0.37, 0.91]) {
    v.renderer.cacheStatic = false;
    const a = shot(q);
    v.renderer.cacheStatic = true;
    shot(q);
    const b = shot(q);
    let over2 = 0, over32 = 0, max = 0;
    for (let i = 0; i < a.length; i++) {
      const d = Math.abs(a[i] - b[i]);
      if (d > max) max = d;
      if (d > 2) over2++;
      if (d > 32) over32++;
    }
    out.push({ q, pixels: w * h, max, over2, over32 });
  }
  v.store.setPlaying(false);
  return out;
})(${JSON.stringify(sets)})`;

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { median: at(0.5), p90: at(0.9), p99: at(0.99), max: s[s.length - 1], over8: xs.filter((x) => x > 8.3).length };
};

try {
  const tab = await openTab();
  await tab.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: false });
  await tab.send('Page.navigate', { url });
  let ready = false;
  for (let i = 0; i < 600 && !ready; i++) {
    await sleep(100);
    ready = await tab.evaluate(`!!document.querySelector('tycho-viewer')?.renderer?.panels.size`).catch(() => false);
  }
  if (!ready) throw new Error('the page did not get a renderer within a minute');
  // a state stored by the page must not move it off the scene's initial state
  await tab.evaluate(`(() => { try { localStorage.clear(); } catch {} document.querySelector('tycho-viewer').reset(); return 1; })()`);
  await sleep(1500);
  if (drag !== null) {
    const d = await tab.evaluate(DRAG);
    const f = stats(d.fine);
    const c = stats(d.coarse);
    const ms = (x) => x.toFixed(2);
    console.log(`${page}: 240 frames of a drag of ${drag}, with the GPU wait`);
    console.log('| per frame, ms | median | p90 | p99 | max | over 8.3 ms |');
    console.log('|---|---|---|---|---|---|');
    console.log(`| antialiased rebuilds | ${ms(f.median)} | ${ms(f.p90)} | ${ms(f.p99)} | ${ms(f.max)} | ${f.over8} |`);
    console.log(`| coarse while dragging | ${ms(c.median)} | ${ms(c.p90)} | ${ms(c.p99)} | ${ms(c.max)} | ${c.over8} |`);
    for (const c of d.checks) console.log(`${c.label}: ${c.over32} of ${c.channels} channels differ from the uncached frame by over 32/255`);
    process.exitCode = d.checks.every((c) => c.over32 <= 0.002 * c.channels) ? 0 : 1;
    throw Object.assign(new Error('dragged'), { done: true });
  }
  if (compare) {
    const rows = await tab.evaluate(COMPARE);
    if (json) console.log(JSON.stringify({ page, sets, rows }));
    else {
      console.log(`${page}: frames with the static-layer cache against frames without it`);
      console.log('| progress | channels over 2/255 | over 32/255 | largest difference |');
      console.log('|---|---|---|---|');
      for (const r of rows) console.log(`| ${r.q} | ${r.over2} of ${4 * r.pixels} | ${r.over32} | ${r.max} |`);
    }
    process.exitCode = rows.every((r) => r.over32 <= 0.002 * 4 * r.pixels) ? 0 : 1;
  }
  const result = compare ? null : await tab.evaluate(MEASURE);
  if (result === null) throw Object.assign(new Error('compared'), { done: true });
  const cpu = stats(result.cpu);
  const gpu = stats(result.gpu);
  const ms = (x) => x.toFixed(2);
  if (json) {
    console.log(
      JSON.stringify({ page, frames, size: [width, height], dpr, sets, renderer: result.renderer, panels: result.panels, steps: result.steps, cpu, gpu }),
    );
  } else {
    console.log(
      `${page}: ${result.panels} panels, ${result.steps} steps, ${frames} frames at ${width}x${height} css px, pixel ratio ${dpr}, ${result.renderer}`,
    );
    if (sets.length) console.log(`variables: ${sets.map(([k, v]) => `${k}=${v}`).join(', ')}`);
    console.log('| per frame, ms | median | p90 | p99 | max | over 8.3 ms |');
    console.log('|---|---|---|---|---|---|');
    console.log(`| CPU only | ${ms(cpu.median)} | ${ms(cpu.p90)} | ${ms(cpu.p99)} | ${ms(cpu.max)} | ${cpu.over8} |`);
    console.log(`| with the GPU wait | ${ms(gpu.median)} | ${ms(gpu.p90)} | ${ms(gpu.p99)} | ${ms(gpu.max)} | ${gpu.over8} |`);
  }
} catch (e) {
  if (!e.done) throw e;
} finally {
  chrome.kill();
  await exited;
  server.close();
  rmSync(profile, { recursive: true, force: true });
}

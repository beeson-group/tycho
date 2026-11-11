// Exports the video of a page through the viewer's exportVideo, in headless Chrome, and writes the MP4 and a poster, i.e. a
// still of the video, as a PNG. The page is exported in its initial state from frame index 0, at speed 1.
//   node web/scripts/video.mjs examples/manifolds/manifolds-slide-dark.html clip-dark.mp4 --size 1200x1600 --dpr 2 --fps 60
// The options are --size WxH (the video in pixels, 1280x720 by default), --dpr D (video pixels per CSS pixel, 1 by default,
// hence the picture is laid out at W/D by H/D CSS pixels), --fps N (30 by default), --loops N (1 by default), --theme dark or
// light (the viewer's palette, by default the scene's theme), --font file.woff2 (a font for the text on the video, by default
// the viewer's), --poster file.png (by default the MP4's path with .png), and --poster-at S (the time of the poster in seconds,
// by default the last frame). Chrome is $CHROME, else the default macOS install, else google-chrome on the PATH.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const [page, out] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (page === undefined || out === undefined) {
  console.error(
    'usage: node web/scripts/video.mjs <page.html> <video.mp4> [--size WxH] [--dpr D] [--fps N] [--loops N] [--theme dark|light] [--font file.woff2] [--font-bold file.woff2] [--poster file.png] [--poster-at S]',
  );
  process.exit(2);
}
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const [width, height] = option('--size', '1280x720').split('x').map(Number);
const pixelRatio = Number(option('--dpr', '1'));
const fps = Number(option('--fps', '30'));
const loops = Number(option('--loops', '1'));
const theme = option('--theme', null);
const fontFile = option('--font', null);
// --font-bold gives the bold face of the same family, for a bold label
const boldFile = option('--font-bold', null);
const poster = option('--poster', out.replace(/\.mp4$/i, '') + '.png');
const posterAt = option('--poster-at', null);

const MAC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executable = process.env.CHROME ?? (existsSync(MAC) ? MAC : 'google-chrome');
// a fresh profile, so that a stored state cannot move the page off its initial state
const profile = mkdtempSync(join(tmpdir(), 'tycho-video-'));
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
  const run = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.result.exceptionDetails !== undefined)
      throw new Error(res.result.exceptionDetails.exception?.description ?? JSON.stringify(res.result.exceptionDetails));
    return res.result.result.value;
  };
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: Math.round(width / pixelRatio),
    height: Math.round(height / pixelRatio),
    deviceScaleFactor: pixelRatio,
    mobile: false,
  });
  await send('Page.navigate', { url: pathToFileURL(resolve(page)).href });
  await load;
  const font = fontFile === null ? null : readFileSync(fontFile).toString('base64');
  const bold = boldFile === null ? null : readFileSync(boldFile).toString('base64');
  const started = performance.now();
  const size = await run(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const v = document.querySelector('tycho-viewer');
    for (let i = 0; i < 600 && !v?.state; i++) await sleep(100);
    if (!v?.state) throw new Error('the viewer did not load a scene');
    ${theme === null ? '' : `v.setAttribute('theme', ${JSON.stringify(theme)});`}
    const font = ${JSON.stringify(font)};
    if (font !== null) {
      const face = new FontFace('tycho-video-font', Uint8Array.from(atob(font), (c) => c.charCodeAt(0)));
      document.fonts.add(await face.load());
      const bold = ${JSON.stringify(bold)};
      if (bold !== null) document.fonts.add(await new FontFace('tycho-video-font', Uint8Array.from(atob(bold), (c) => c.charCodeAt(0)), { weight: 'bold' }).load());
      v.style.setProperty('--tycho-font', 'tycho-video-font');
    }
    const blob = await v.exportVideo({ size: { width: ${width}, height: ${height}, pixelRatio: ${pixelRatio} }, fps: ${fps}, loops: ${loops}, speed: 1 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    window.__video = btoa(text);
    window.__blob = blob;
    return bytes.length;
  })()`);
  // the MP4 is read back in slices, since one message of the protocol would be too large
  const parts = [];
  for (let at = 0; ; at += 1 << 22) {
    const part = await run(`window.__video.slice(${at}, ${at + (1 << 22)})`);
    if (part === '') break;
    parts.push(part);
  }
  writeFileSync(out, Buffer.from(parts.join(''), 'base64'));
  console.log(`wrote ${out} (${(size / 1e6).toFixed(1)} MB, ${width}x${height} at ${fps} fps) in ${((performance.now() - started) / 1000).toFixed(0)} s`);
  // the poster is a frame of the MP4 itself, decoded by the page's video element
  const still = await run(`(async () => {
    const video = document.createElement('video');
    video.muted = true;
    video.src = URL.createObjectURL(window.__blob);
    await new Promise((r, j) => ((video.onloadedmetadata = r), (video.onerror = () => j(new Error('Chrome could not decode the MP4')))));
    const at = ${posterAt === null ? `video.duration - 0.5 / ${fps}` : Number(posterAt)};
    video.currentTime = Math.max(0, Math.min(at, video.duration));
    await new Promise((r) => (video.onseeked = r));
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    return [video.currentTime, canvas.toDataURL('image/png').split(',')[1]];
  })()`);
  writeFileSync(poster, Buffer.from(still[1], 'base64'));
  console.log(`wrote ${poster} at ${still[0].toFixed(2)} s`);
  ws.close();
} finally {
  chrome.kill();
  await exited;
  rmSync(profile, { recursive: true, force: true });
}

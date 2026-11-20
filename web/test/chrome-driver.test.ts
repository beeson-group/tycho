// Tests how the tests and the scripts of web/ start and end Google Chrome. On macOS, Chrome copies its app into a temp folder at each
// start unless its feature MacAppCodeSignClone is disabled, and removes the copy only at an exit of its own. The test of the copies
// runs on macOS where Chrome is found. The tests of closeChrome run against a stand-in for Chrome, which is a script of Node.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chromeArgs, closeChrome } from '../scripts/chrome.mjs';
import { Chrome, findChrome } from './chrome-driver';

const chromePath = findChrome();

/** The copies of its app that Chrome keeps on macOS, as paths below the folder beside the temp folder of the user. */
function codeSignClones(): string[] {
  const folder = join(dirname(execFileSync('getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).trim()), 'X');
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((name) => name.endsWith('.code_sign_clone'))
    .flatMap((name) => readdirSync(join(folder, name)).map((clone) => join(name, clone)));
}

// The stand-in answers /json/version and accepts a WebSocket as Chrome does. Its first message is unmasked as a text frame under 126
// bytes. Under `exits`, the stand-in exits 300 ms after a Browser.close, and under `hangs` it does not exit by itself.
const STAND_IN = `
const { createHash } = require('node:crypto');
const server = require('node:http').createServer((req, res) => {
  res.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:' + server.address().port + '/devtools/browser/stand-in' }));
});
server.on('upgrade', (req, socket) => {
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');
  socket.once('data', (frame) => {
    const message = JSON.parse(Buffer.from(frame.subarray(6).map((byte, i) => byte ^ frame[2 + (i % 4)])).toString());
    if (message.method === 'Browser.close' && process.argv[1] === 'exits') setTimeout(() => process.exit(0), 300);
  });
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
`;

/** Starts the stand-in for Chrome under `mode`, and returns its process and its port. */
async function standIn(mode: 'exits' | 'hangs'): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(process.execPath, ['-e', STAND_IN, '--', mode], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise<number>((resolve) => child.stdout!.once('data', (d: Buffer) => resolve(Number(d.toString()))));
  return { child, port };
}

describe('the arguments of Chrome', () => {
  const features = (platform: NodeJS.Platform) => chromeArgs('profile', 0, platform).filter((arg) => arg.startsWith('--disable-features='));

  it('disable MacAppCodeSignClone on macOS, in one --disable-features, since Chrome reads only the last one', () => {
    expect(features('darwin')).toEqual(['--disable-features=MacAppCodeSignClone']);
  });

  it('do not disable a feature on Linux and Windows', () => {
    expect(features('linux')).toEqual([]);
    expect(features('win32')).toEqual([]);
  });
});

describe('closeChrome', () => {
  it('leaves Chrome to exit after Browser.close, without a signal', async () => {
    const { child, port } = await standIn('exits');
    await closeChrome(child, port);
    expect([child.exitCode, child.signalCode]).toEqual([0, null]);
  });

  it('ends a Chrome that does not exit after Browser.close', async () => {
    const { child, port } = await standIn('hangs');
    await closeChrome(child, port, 500);
    expect(child.signalCode).toBe('SIGTERM');
  });
});

describe.skipIf(chromePath === null || process.platform !== 'darwin')('a Chrome of the driver on macOS', () => {
  // Chrome makes the copy before it answers its first command. another Chrome of the same Mac may be started during an attempt
  it('does not copy its app into a temp folder', async () => {
    for (let attempt = 1; ; attempt++) {
      const before = new Set(codeSignClones());
      const chrome = await Chrome.launch(chromePath!);
      const copies = codeSignClones().filter((clone) => !before.has(clone));
      await chrome.close();
      if (copies.length === 0) return;
      expect(attempt, `a copy of the app was made at each of 3 starts of Chrome, the last one at ${copies}`).toBeLessThan(3);
    }
  }, 60000);
});

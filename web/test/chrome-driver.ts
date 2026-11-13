// A headless Chrome driven over the DevTools protocol, with the WebSocket client of Node, for the tests that need a real page.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

/** The path of a Google Chrome on this machine, or null. Chromium is not looked for, since it lacks the H.264 encoder. */
export function findChrome(): string | null {
  return CANDIDATES.find((p) => p !== undefined && p !== '' && existsSync(p)) ?? null;
}

export class Chrome {
  private readonly proc: ChildProcess;
  private readonly ws: WebSocket;
  private readonly profile: string;

  private constructor(proc: ChildProcess, ws: WebSocket, profile: string) {
    this.proc = proc;
    this.ws = ws;
    this.profile = profile;
  }

  private next = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  session = '';

  /** Starts a headless Chrome at `path` and attaches to a new page. */
  static async launch(path: string, extra: string[] = []): Promise<Chrome> {
    const profile = mkdtempSync(join(tmpdir(), 'tycho-chrome-'));
    const proc = spawn(
      path,
      [
        '--headless=new',
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--hide-scrollbars',
        '--allow-file-access-from-files',
        '--enable-unsafe-swiftshader',
        // the runners of GitHub Actions on Ubuntu 24.04 deny Chrome the user namespaces of its sandbox
        ...(process.env.CI ? ['--no-sandbox'] : []),
        ...extra,
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    const url = await new Promise<string>((resolve, reject) => {
      let err = '';
      proc.stderr!.on('data', (d: Buffer) => {
        err += d.toString();
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
        if (m !== null) resolve(m[1]!);
      });
      proc.on('exit', (code) => reject(new Error(`Chrome exited with ${code}: ${err.slice(-2000)}`)));
    });
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error(`cannot connect to ${url}`));
    });
    const chrome = new Chrome(proc, ws, profile);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (msg.id === undefined) return;
      const p = chrome.pending.get(msg.id);
      chrome.pending.delete(msg.id);
      if (msg.error !== undefined) p?.reject(new Error(msg.error.message));
      else p?.resolve(msg.result);
    };
    const { targetId } = (await chrome.send('Target.createTarget', { url: 'about:blank' }, '')) as { targetId: string };
    const { sessionId } = (await chrome.send('Target.attachToTarget', { targetId, flatten: true }, '')) as { sessionId: string };
    chrome.session = sessionId;
    return chrome;
  }

  /** Sends a command to the page, or to the browser when `session` is the empty string. */
  send(method: string, params: object = {}, session = this.session): Promise<unknown> {
    const id = this.next++;
    this.ws.send(JSON.stringify({ id, method, params, ...(session === '' ? {} : { sessionId: session }) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  /** Evaluates an expression in the page, awaits it, and returns its value as JSON. */
  async evaluate<T>(expression: string): Promise<T> {
    const r = (await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })) as {
      result: { value: T };
      exceptionDetails?: { exception?: { description?: string }; text: string };
    };
    if (r.exceptionDetails !== undefined) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }

  close(): void {
    this.ws.close();
    this.proc.kill();
    try {
      rmSync(this.profile, { recursive: true, force: true });
    } catch {
      // Chrome may still hold the profile, which the system's temporary folder then keeps
    }
  }
}

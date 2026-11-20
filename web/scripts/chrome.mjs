// How the scripts and the tests of web/ start and end a headless Chrome.

/**
 * The arguments of every Chrome that is started from web/. A caller appends its own arguments and the address of the first page.
 * Chrome reads only the last --disable-features of a command line, hence a further feature is added to the one below after a comma.
 * @param {string} profile The folder of a fresh profile.
 * @param {number} port The port of the DevTools protocol, or 0 for a port that Chrome chooses.
 * @param {NodeJS.Platform} [platform]
 * @returns {string[]}
 */
export function chromeArgs(profile, port, platform = process.platform) {
  return [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    // with MacAppCodeSignClone, Chrome copies its app into a temp folder of macOS at each start, and the copy is left there when Chrome
    // is ended by a signal or with the process that started it
    ...(platform === 'darwin' ? ['--disable-features=MacAppCodeSignClone'] : []),
  ];
}

/**
 * Ends a Chrome with Browser.close of the DevTools protocol and waits for its exit, since Chrome removes what it has written outside
 * its profile only at an exit of its own. A Chrome that does not answer on `port`, or that has not exited after `wait` ms, is ended
 * with SIGTERM.
 * @param {import('node:child_process').ChildProcess} child The process of Chrome.
 * @param {number} port The port of the DevTools protocol of this Chrome.
 * @param {number} [wait]
 * @returns {Promise<void>}
 */
export async function closeChrome(child, port, wait = 5000) {
  const running = () => child.exitCode === null && child.signalCode === null;
  const exited = new Promise((done) => (running() ? child.once('exit', done) : done(null)));
  let timer;
  const late = new Promise((done) => (timer = setTimeout(done, wait)));
  let ws;
  try {
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(wait) })).json();
    ws = new WebSocket(version.webSocketDebuggerUrl);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    await Promise.race([exited, late]);
  } catch {
    // a Chrome whose port is closed is ended below
  }
  clearTimeout(timer);
  ws?.close();
  if (running()) child.kill();
  await exited;
}

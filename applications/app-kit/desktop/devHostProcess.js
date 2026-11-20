// Play › Multiplayer's dev host, started by the desktop editor itself: the same `cleo-host --dev` that
// `npm run host -- --dev` runs in a terminal (applications/host/src/devHost.ts), as a process of its own that the
// editor starts when Play › Multiplayer asks for it and that goes when the editor quits.
//
//   From the repository (npm run desktop:dev): the host's source through vite-node, on this machine's Node, as
//     the terminal command runs it: always the code as it is now, nothing to build first.
//   An installed editor: the built host (applications/host/dist, packed into resources/host with its packages),
//     on Electron's own Node, as a utility process: nothing to install.
//
// It only ever listens on 127.0.0.1, on the port of the editor's Dev host address. A dev host already answering
// there (one started in a terminal) is used as it is; anything else on that port is reported, never fought. The
// host is told this process's id (--owner-pid) and stops by itself when it is gone, so a crashed editor leaves no
// host holding the ports.

const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

/** Lines of the host's output kept, for the error when it stops. */
const TAIL = 60;
/** A first start from the repository compiles the engine through vite-node: allow it. */
const READY_TIMEOUT_MS = 180000;
const POLL_MS = 300;

/**
 * What answers on 127.0.0.1:`port`: 'dev' (a dev host: its /dev/endpoint names a WebTransport address), 'other'
 * (something else answers there) or 'none' (nothing listens).
 */
function probe(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/dev/endpoint', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 4096) body += c; });
      res.on('end', () => {
        try { resolve(res.statusCode === 200 && JSON.parse(body)?.webTransport?.url ? 'dev' : 'other'); } catch { resolve('other'); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve('other'); });
    req.on('error', (e) => resolve(e && e.code === 'ECONNREFUSED' ? 'none' : 'other'));
  });
}

/** The first `node_modules/vite-node/vite-node.mjs` from `dir` up, or null. Pure but for the file system. */
function findViteNode(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    const candidate = path.join(d, 'node_modules', 'vite-node', 'vite-node.mjs');
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(d) === d) return null;
  }
}

/** How to run the host here: from the repository's source, or the build packed into the installed app. */
function hostCommand(app) {
  if (app.isPackaged) {
    const entry = path.join(process.resourcesPath, 'host', 'cleo-host.mjs');
    if (!fs.existsSync(entry)) return { error: 'This editor was built without its dev host (resources/host is missing).' };
    return { kind: 'utility', entry, args: ['--cache', path.join(app.getPath('userData'), 'dev-host')] };
  }
  const hostDir = path.join(__dirname, '..', '..', 'host');
  if (!fs.existsSync(path.join(hostDir, 'src', 'main.ts'))) return { error: `The host's source is not at ${hostDir}.` };
  if (!fs.existsSync(path.join(hostDir, 'node_modules', '@fails-components', 'webtransport'))) {
    return { error: 'The host\'s packages are not installed. Once, at the repository: npm run host:install' };
  }
  const viteNode = findViteNode(hostDir);
  if (!viteNode) return { error: 'vite-node is not installed. Once, at the repository: npm run apps:install' };
  return { kind: 'node', cwd: hostDir, args: [viteNode, 'src/main.ts', '--'] };
}

function registerIpc({ ipcMain, app, BrowserWindow, utilityProcess }) {
  /** The host this editor started: { proc, port, tail, exited, ready }. */
  let current = null;
  /** One start at a time: the dialog's open and its Start may both ask. */
  let chain = Promise.resolve();

  const broadcast = (payload) => {
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('devhost:event', payload);
  };

  function stop() {
    const c = current;
    current = null;
    if (c && !c.exited) { c.stopped = true; try { c.proc.kill(); } catch { /* already gone */ } }
  }

  function launch(port, cmd) {
    const args = [...cmd.args, '--dev', '--control-port', String(port), '--owner-pid', String(process.pid)];
    let proc;
    if (cmd.kind === 'utility') {
      proc = utilityProcess.fork(cmd.entry, args, { cwd: path.dirname(cmd.entry), stdio: 'pipe', serviceName: 'Cleo dev host' });
    } else {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      proc = spawn('node', args, { cwd: cmd.cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    }
    const c = { proc, port, tail: [], exited: false, stopped: false, readyOnce: false, exitCode: null, spawnError: null, ready: null };
    const take = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue;
        c.tail.push(line);
        if (c.tail.length > TAIL) c.tail.shift();
        console.log(`[dev host] ${line}`);
      }
    };
    proc.stdout?.on('data', take);
    proc.stderr?.on('data', take);
    // child_process: 'error' when `node` cannot be started at all (not on the PATH).
    proc.on?.('error', (e) => {
      c.spawnError = e && e.code === 'ENOENT'
        ? 'Node.js is not on the PATH: the dev host runs from the repository on this machine\'s Node (22 or newer).'
        : String(e?.message ?? e);
      c.exited = true;
    });
    proc.on('exit', (code) => {
      c.exited = true;
      c.exitCode = code;
      if (current === c) current = null;
      if (!c.stopped && c.readyOnce) broadcast({ type: 'exit', port, code, tail: c.tail.slice(-12) });
    });
    return c;
  }

  /** Wait until `c` answers as a dev host, or stops. */
  async function waitReady(c) {
    const until = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < until) {
      if (c.exited) {
        if (c.spawnError) return { ok: false, error: c.spawnError };
        const last = c.tail.slice(-6).join('\n');
        return { ok: false, error: `The dev host stopped (exit code ${c.exitCode ?? '?'}).${last ? `\n${last}` : ''}` };
      }
      if (await probe(c.port, 1000) === 'dev') { c.readyOnce = true; return { ok: true, started: true, port: c.port }; }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    stop();
    return { ok: false, error: 'The dev host did not come up in time.' };
  }

  async function start(port) {
    if (current && !current.exited) {
      if (current.port === port) return current.ready;
      stop(); // the address now names another port
    }
    const there = await probe(port);
    if (there === 'dev') return { ok: true, external: true, port };
    if (there === 'other') {
      return { ok: false, error: `Something else is using port ${port} (a NetSync host started without --dev?). Stop it, or give the dev host another address.` };
    }
    const cmd = hostCommand(app);
    if (cmd.error) return { ok: false, error: cmd.error };
    const c = launch(port, cmd);
    current = c;
    c.ready = waitReady(c);
    return c.ready;
  }

  ipcMain.handle('devhost:start', (_event, port) => {
    const p = Math.round(Number(port));
    if (!Number.isInteger(p) || p < 1024 || p > 65535) return { ok: false, error: 'Not a port the dev host can use.' };
    const run = chain.then(() => start(p));
    chain = run.catch(() => {});
    return run.catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
  });

  ipcMain.handle('devhost:stop', () => { stop(); return { ok: true }; });

  ipcMain.handle('devhost:status', () => (current && !current.exited
    ? { running: true, port: current.port, tail: current.tail.slice(-20) }
    : { running: false }));

  app.on('will-quit', stop);
}

module.exports = { registerIpc, probe, findViteNode, hostCommand };

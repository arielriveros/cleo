const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// The editor's command line, for tools outside it: a named pipe (Windows) or a unix socket the `cleo` CLI in
// every project folder connects to (`npm run play`, `npm run debug`). One per main process.
//
// The protocol is line-delimited JSON. A request is `{ id, token, cmd, ...args }`; the reply `{ id, ok, ... }`.
// The token is written, with the pipe's name, into `.cleo/local/editor.json` of each project this editor
// opens (gitignored, machine-local): only something that can read the project folder can drive the editor.
// Commands are relayed to the editor window, which owns the project; until it says it is ready they wait.
//
//   ping                 -> { ok, root }                  the open project folder, if any
//   play { root, debug } -> { ok, port? }                 open the project if needed, then Play in window
//   open { root }        -> { ok }                        open the project

let token = null;
let pipeName = null;
let server = null;
let target = null;          // { webContents } of the editor window
let ready = false;
const queue = [];           // commands waiting for the renderer
const pending = new Map();  // id -> socket reply function
let nextId = 1;

function pipePath(userData) {
  const hash = crypto.createHash('sha1').update(userData).digest('hex').slice(0, 12);
  return process.platform === 'win32' ? `\\\\.\\pipe\\cleo-editor-${hash}` : path.join(os.tmpdir(), `cleo-editor-${hash}.sock`);
}

/** Start listening. `userData` names the pipe, so the dev and packaged builds each have their own. */
function start(userData) {
  if (server) return pipeName;
  pipeName = pipePath(userData);
  // One token per build and machine, kept in userData: a project's editor.json stays valid across restarts.
  const tokenFile = path.join(userData, 'control.token');
  try { token = fs.readFileSync(tokenFile, 'utf-8').trim(); } catch { /* first run */ }
  if (!token || !/^[0-9a-f]{32}$/.test(token)) {
    token = crypto.randomBytes(16).toString('hex');
    try { fs.mkdirSync(userData, { recursive: true }); fs.writeFileSync(tokenFile, token, { mode: 0o600 }); } catch { /* the token still works this session */ }
  }
  if (process.platform !== 'win32') { try { fs.unlinkSync(pipeName); } catch { /* none */ } }
  server = net.createServer(socket => {
    let buffer = '';
    socket.setEncoding('utf-8');
    socket.on('data', chunk => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        handleLine(line, reply => { try { socket.write(JSON.stringify(reply) + '\n'); } catch { /* gone */ } });
      }
    });
    socket.on('error', () => {});
  });
  server.on('error', () => { /* another instance holds it: the single-instance lock makes that one the editor */ });
  server.listen(pipeName);
  return pipeName;
}

function handleLine(line, reply) {
  let msg;
  try { msg = JSON.parse(line); } catch { reply({ ok: false, error: 'not JSON' }); return; }
  const clientId = msg.id;
  if (msg.token !== token) { reply({ id: clientId, ok: false, error: 'bad token' }); return; }
  if (!['ping', 'play', 'open'].includes(msg.cmd)) { reply({ id: clientId, ok: false, error: `unknown command ${msg.cmd}` }); return; }
  const id = nextId++;
  pending.set(id, result => reply({ id: clientId, ...result }));
  const command = { id, cmd: msg.cmd, root: typeof msg.root === 'string' ? msg.root : undefined, debug: !!msg.debug };
  if (ready && target && !target.isDestroyed()) target.send('control:command', command);
  else queue.push(command);
}

/** The editor window the commands go to. Commands wait until its renderer reports ready. */
function attach(webContents) {
  target = webContents;
  ready = false;
  webContents.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) ready = false; });
}

function registerIpc({ ipcMain, allow }) {
  ipcMain.handle('control:ready', (event) => {
    if (!target || event.sender !== target) target = event.sender;
    ready = true;
    while (queue.length) {
      const command = queue.shift();
      if (command.root && allow) command.root = allow(command.root);
      target.send('control:command', command);
    }
    return { ok: true };
  });
  ipcMain.handle('control:reply', (_event, id, result) => {
    const fn = pending.get(id);
    pending.delete(id);
    if (fn) fn(result && typeof result === 'object' ? result : { ok: !!result });
    return { ok: true };
  });
}

/** What a project folder's `.cleo/local/editor.json` says about this editor. */
function editorRecord(app) {
  // The exact command that starts THIS build again: the packaged exe, or electron + the shell in a checkout.
  const args = process.argv.slice(1).filter(a => !a.startsWith('--cleo-') && !a.startsWith('--remote-debugging') && !a.startsWith('--inspect'));
  const env = {};
  if (process.env.CLEO_DEV) env.CLEO_DEV = process.env.CLEO_DEV;
  return {
    pipe: pipeName,
    token,
    pid: process.pid,
    version: app.getVersion(),
    relaunch: { exe: process.execPath, args: app.isPackaged ? [] : args, env },
  };
}

module.exports = { start, attach, registerIpc, editorRecord, token: () => token, pipe: () => pipeName };

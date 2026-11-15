// The game windows' debug port, for VS Code: Options ▸ Editor ▸ Scripts ▸ Debug scripts with ▸ VS Code.
//
// VS Code's JavaScript debugger (js-debug, "type": "chrome", "request": "attach") talks to Chrome's remote
// debugging endpoint: GET /json/version names a browser WebSocket; over it, Target.setDiscoverTargets
// lists the pages, Target.attachToTarget {flatten} opens a session on one, and every page command carries
// that sessionId. Electron's own --remote-debugging-port would give it that — for EVERY window, the editor
// included, whose preload reaches the user's files, and only from a restart. This serves the same endpoint
// itself, with the game windows (playWindow.js: sandboxed, no preload) as the only targets, while the
// editor asks for it.
//
// A target's protocol session is `webContents.debugger`, which a window has one of. So it is either Cleo's
// own debugger's (playDebugger.js) or this port's, never both: the editor only turns the port on with
// Cleo's debugger off, and each side refuses a window the other holds.
//
// Only 127.0.0.1, a Host header naming it (DNS rebinding), and no WebSocket from a web page (an Origin
// header): Chrome's own rules for its endpoint. The WebSocket server is written out here (RFC 6455, text
// frames) so the packaged app needs no dependency for it.

const http = require('http');
const crypto = require('crypto');

// ---- WebSocket, server side --------------------------------------------------------------------------

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Sec-WebSocket-Accept for a client's Sec-WebSocket-Key. */
function acceptKey(key) {
  return crypto.createHash('sha1').update(String(key) + WS_GUID).digest('base64');
}

/** One unmasked, final frame (a server never masks). */
function encodeFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = body.length;
  const head = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  head[0] = 0x80 | (opcode & 0x0f);
  if (len < 126) head[1] = len;
  else if (len < 65536) { head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, body]);
}

/**
 * Reassembles a client's frames into messages: masked payloads, 16- and 64-bit lengths, fragmented messages
 * (continuation frames), control frames between fragments. `push` returns what completed.
 */
class FrameReader {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.fragments = null; // { opcode, parts }
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const out = [];
    for (;;) {
      const b = this.buffer;
      if (b.length < 2) break;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let offset = 2;
      if (len === 126) { if (b.length < 4) break; len = b.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (b.length < 10) break; len = Number(b.readBigUInt64BE(2)); offset = 10; }
      const maskAt = offset;
      if (masked) offset += 4;
      if (b.length < offset + len) break;
      const payload = Buffer.from(b.subarray(offset, offset + len));
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= b[maskAt + (i & 3)];
      this.buffer = b.subarray(offset + len);
      if (opcode >= 0x8) { out.push({ opcode, payload }); continue; } // control frames are never fragmented
      if (opcode === 0x0) {
        if (!this.fragments) continue; // a stray continuation: nothing to continue
        this.fragments.parts.push(payload);
        if (fin) { out.push({ opcode: this.fragments.opcode, payload: Buffer.concat(this.fragments.parts) }); this.fragments = null; }
        continue;
      }
      if (fin) out.push({ opcode, payload });
      else this.fragments = { opcode, parts: [payload] };
    }
    return out;
  }
}

/** A WebSocket over an upgraded socket: text messages in and out, pings answered, close handled. */
function webSocket(socket, onText, onClose) {
  const reader = new FrameReader();
  let closed = false;
  const finish = () => { if (closed) return; closed = true; try { socket.destroy(); } catch { /* gone */ } onClose(); };
  socket.on('data', (chunk) => {
    let frames;
    try { frames = reader.push(chunk); } catch { finish(); return; }
    for (const f of frames) {
      if (f.opcode === 0x1) onText(f.payload.toString('utf8'));
      else if (f.opcode === 0x9) socket.write(encodeFrame(0xa, f.payload)); // ping -> pong
      else if (f.opcode === 0x8) { try { socket.write(encodeFrame(0x8, f.payload.subarray(0, 2))); } catch { /* gone */ } finish(); return; }
    }
  });
  socket.on('close', finish);
  socket.on('error', finish);
  return {
    send(text) { if (!closed) socket.write(encodeFrame(0x1, text)); },
    close() { if (!closed) { try { socket.write(encodeFrame(0x8, Buffer.from([0x03, 0xe8]))); } catch { /* gone */ } finish(); } },
    get closed() { return closed; },
  };
}

// ---- The endpoint --------------------------------------------------------------------------------

/**
 * Hosts a request may name: this machine, by address or as localhost, with or without a port — the rule
 * Chrome's endpoint applies against DNS rebinding. (js-debug's WebSocket sends `Host: localhost`, no port.)
 */
function hostAllowed(host) {
  const h = String(host || '').toLowerCase();
  const name = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0];
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

/**
 * The port. `targets()` lists the game windows that may be debugged: `{ id, title, url, contents, owner,
 * heldByCleo }`, `id` being the play session's id. `emit(owner, payload)` reports to an editor window, and
 * `broadcast(payload)` to every one that asked for the port.
 */
function createDebugPort({ targets, emit, broadcast, product = 'Cleo', log = () => {}, trace = null }) {
  let server = null;
  let port = 0;
  const browserId = crypto.randomUUID();
  /** Open connections: { ws, discover, implicit } — `implicit` is a page connection's target id. */
  const clients = new Set();
  /** targetId -> { client, sessionId, target, dbg, children, onMessage, onDetach } */
  const attached = new Map();
  /** The targets the discovering clients were last told about, by id. */
  let known = new Map();

  const targetInfo = (t) => ({
    targetId: t.id, type: 'page', title: t.title || 'Cleo game', url: t.url, attached: attached.has(t.id),
    canAccessOpener: false, browserContextId: 'cleo',
  });
  const find = (id) => targets().find(t => t.id === id);
  const status = () => ({ type: 'vscode-status', listening: !!server, port, clients: clients.size });
  const send = (client, message) => {
    const text = JSON.stringify(message);
    if (trace) trace('out', text);
    client.ws.send(text);
  };
  // The Target domain's events, on the session the client opened on the browser itself if it did (js-debug
  // does, with Target.attachToBrowserTarget, and listens there only).
  const browserEvent = (client, method, params) =>
    send(client, { method, params, ...(client.browserSession ? { sessionId: client.browserSession } : {}) });

  function detach(targetId, notify = true) {
    const rec = attached.get(targetId);
    if (!rec) return;
    attached.delete(targetId);
    rec.dbg.removeListener('message', rec.onMessage);
    rec.dbg.removeListener('detach', rec.onDetach);
    // Detaching resumes a page stopped at a breakpoint.
    try { if (!rec.target.contents.isDestroyed() && rec.dbg.isAttached()) rec.dbg.detach(); } catch { /* gone */ }
    if (notify && !rec.client.ws.closed && !rec.client.implicit) browserEvent(rec.client, 'Target.detachedFromTarget', { sessionId: rec.sessionId, targetId });
  }

  function attach(client, targetId, implicit) {
    const target = find(targetId);
    if (!target) throw new Error(`No target with given id found: ${targetId}`);
    if (target.heldByCleo) throw new Error("The game is being debugged in Cleo. Choose VS Code in Options ▸ Editor ▸ Scripts and press Play again.");
    const held = attached.get(targetId);
    if (held && held.client !== client) throw new Error('Another debugger is attached to this game window');
    if (held) return held.sessionId;
    const dbg = target.contents.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    const rec = { client, sessionId: implicit ? '' : crypto.randomUUID().replace(/-/g, '').toUpperCase(), target, dbg, children: new Set() };
    rec.onMessage = (_event, method, params, childSession) => {
      if (method === 'Target.attachedToTarget' && params && params.sessionId) rec.children.add(params.sessionId);
      if (method === 'Target.detachedFromTarget' && params && params.sessionId) rec.children.delete(params.sessionId);
      const sessionId = childSession || rec.sessionId;
      send(client, { method, params: params || {}, ...(sessionId ? { sessionId } : {}) });
      if (!childSession && method === 'Debugger.paused') emit(target.owner, { sessionId: targetId, type: 'vscode-paused' });
      if (!childSession && method === 'Debugger.resumed') emit(target.owner, { sessionId: targetId, type: 'vscode-resumed' });
    };
    rec.onDetach = () => detach(targetId);
    dbg.on('message', rec.onMessage);
    dbg.on('detach', rec.onDetach);
    attached.set(targetId, rec);
    return rec.sessionId;
  }

  /** The browser-level methods a debugger needs to find a page and open a session on it. */
  function browserCommand(client, method, params) {
    switch (method) {
      case 'Browser.getVersion':
        return { protocolVersion: '1.3', product, revision: '', userAgent: product, jsVersion: process.versions.v8 };
      case 'Target.setDiscoverTargets':
        client.discover = !!(params && params.discover);
        if (client.discover) setImmediate(() => { for (const t of targets()) browserEvent(client, 'Target.targetCreated', { targetInfo: targetInfo(t) }); });
        return {};
      case 'Target.getTargets':
        return { targetInfos: targets().map(targetInfo) };
      case 'Target.getTargetInfo': {
        const t = params && params.targetId ? find(params.targetId) : null;
        return { targetInfo: t ? targetInfo(t) : { targetId: browserId, type: 'browser', title: product, url: '', attached: true } };
      }
      case 'Target.attachToTarget': {
        const targetId = params && params.targetId;
        const sessionId = attach(client, targetId, false);
        const t = find(targetId);
        setImmediate(() => browserEvent(client, 'Target.attachedToTarget', { sessionId, targetInfo: { ...targetInfo(t), attached: true }, waitingForDebugger: false }));
        broadcast(status());
        return { sessionId };
      }
      case 'Target.detachFromTarget': {
        for (const [id, rec] of attached) if (rec.client === client && (!params || rec.sessionId === params.sessionId)) detach(id);
        return {};
      }
      case 'Target.closeTarget':
        return { success: false };
      case 'Target.attachToBrowserTarget':
        client.browserSession = client.browserSession || `BROWSER${crypto.randomUUID().replace(/-/g, '').toUpperCase()}`;
        return { sessionId: client.browserSession };
      default:
        // setAutoAttach, activateTarget, setRemoteLocations, ...: nothing to do for windows this side owns.
        log(`debug port: browser method ${method} answered with {}`);
        return {};
    }
  }

  async function onClientText(client, text) {
    if (trace) trace('in', text);
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    const { id, method, params, sessionId } = msg;
    const reply = (body) => send(client, { id, ...body, ...(sessionId ? { sessionId } : {}) });
    try {
      // A page command: to the session's page, or to one of its child targets (workers) by their own id.
      const page = client.implicit && !sessionId ? attached.get(client.implicit)
        : [...attached.values()].find(r => r.client === client && (r.sessionId === sessionId || r.children.has(sessionId)));
      if (page && (sessionId || client.implicit)) {
        const child = sessionId && sessionId !== page.sessionId ? sessionId : undefined;
        const result = await page.dbg.sendCommand(method, params || {}, child);
        reply({ result: result || {} });
        // js-debug's last step once its breakpoints are in: the editor may let the game boot.
        if (!child && method === 'Runtime.runIfWaitingForDebugger') emit(page.target.owner, { sessionId: page.target.id, type: 'vscode-ready' });
        // Continue (not a step): the player goes back to the game, whose window VS Code is likely covering.
        if (!child && method === 'Debugger.resume') emit(page.target.owner, { sessionId: page.target.id, type: 'vscode-continued' });
        return;
      }
      if (sessionId && sessionId !== client.browserSession) throw new Error(`Session with given id not found: ${sessionId}`);
      reply({ result: browserCommand(client, method, params) });
    } catch (e) {
      reply({ error: { code: -32000, message: String(e && e.message ? e.message : e) } });
    }
  }

  function onUpgrade(req, socket) {
    if (trace) trace('upgrade', `${req.url} host=${req.headers.host} origin=${req.headers.origin || ''}`);
    const url = new URL(req.url, 'http://x');
    const fail = (code) => { socket.end(`HTTP/1.1 ${code}\r\n\r\n`); };
    if (!hostAllowed(req.headers.host)) return fail('403 Forbidden');
    // A web page's WebSocket always carries an Origin; a debugger's does not.
    if (req.headers.origin) return fail('403 Forbidden');
    const key = req.headers['sec-websocket-key'];
    const pageMatch = /^\/devtools\/page\/([^/]+)$/.exec(url.pathname);
    const isBrowser = url.pathname === `/devtools/browser/${browserId}`;
    if (!key || (!pageMatch && !isBrowser)) return fail('404 Not Found');
    if (pageMatch && !find(pageMatch[1])) return fail('404 Not Found');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
    socket.setNoDelay(true);
    const client = { ws: null, discover: false, implicit: pageMatch ? pageMatch[1] : null };
    client.ws = webSocket(socket, text => { void onClientText(client, text); }, () => {
      clients.delete(client);
      for (const [id, rec] of attached) if (rec.client === client) detach(id, false);
      broadcast(status());
    });
    clients.add(client);
    if (client.implicit) {
      try { attach(client, client.implicit, true); } catch (e) { client.ws.close(); return; }
    }
    broadcast(status());
  }

  function onRequest(req, res) {
    if (trace) trace('http', `${req.method} ${req.url} host=${req.headers.host}`);
    // One request per connection: nothing keeps a socket to a port that may be closed a moment later.
    const json = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=UTF-8', Connection: 'close' });
      res.end(JSON.stringify(body, null, 2));
    };
    if (!hostAllowed(req.headers.host)) return json(403, { error: 'Host header must be localhost' });
    const path = new URL(req.url, 'http://x').pathname.replace(/\/$/, '');
    if (path === '/json/version') {
      return json(200, {
        Browser: product, 'Protocol-Version': '1.3', 'User-Agent': product, 'V8-Version': process.versions.v8,
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/${browserId}`,
      });
    }
    if (path === '/json' || path === '/json/list') {
      return json(200, targets().map(t => ({
        id: t.id, type: 'page', title: t.title || 'Cleo game', url: t.url, description: '',
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${t.id}`,
      })));
    }
    return json(404, { error: 'Not found' });
  }

  return {
    /** Listen on `wanted` (127.0.0.1). Resolves { ok, port } or { ok: false, error }, never rejects. */
    listen(wanted) {
      const p = Math.round(Number(wanted));
      if (!Number.isInteger(p) || p < 1024 || p > 65535) return Promise.resolve({ ok: false, error: 'The port must be between 1024 and 65535' });
      if (server && port === p) return Promise.resolve({ ok: true, port });
      return this.close().then(() => new Promise((resolve) => {
        const s = http.createServer(onRequest);
        s.on('upgrade', onUpgrade);
        s.once('error', (e) => { resolve({ ok: false, error: e && e.code === 'EADDRINUSE' ? `Port ${p} is in use by another program` : String(e && e.message ? e.message : e) }); });
        s.listen(p, '127.0.0.1', () => { server = s; port = p; broadcast(status()); resolve({ ok: true, port }); });
      }));
    },
    close() {
      for (const id of [...attached.keys()]) detach(id);
      for (const c of [...clients]) c.ws.close();
      clients.clear();
      const s = server;
      server = null;
      if (!s) return Promise.resolve();
      return new Promise(resolve => {
        s.close(() => { broadcast(status()); resolve(); });
        s.closeAllConnections();
      });
    },
    get port() { return server ? port : 0; },
    status,
    /** Whether this port holds the target's session (Cleo's own debugger must not attach then). */
    holds: (targetId) => attached.has(targetId),
    /** The game windows changed (one opened, navigated, closed): tell the discovering clients. */
    targetsChanged() {
      const now = new Map(targets().map(t => [t.id, t]));
      for (const [id] of known) if (!now.has(id)) {
        detach(id);
        for (const c of clients) if (c.discover) browserEvent(c, 'Target.targetDestroyed', { targetId: id });
      }
      for (const [id, t] of now) {
        const before = known.get(id);
        const event = !before ? 'Target.targetCreated' : before.url !== t.url || before.title !== t.title ? 'Target.targetInfoChanged' : null;
        if (event) for (const c of clients) if (c.discover) browserEvent(c, event, { targetInfo: targetInfo(t) });
      }
      known = new Map([...now].map(([id, t]) => [id, { url: t.url, title: t.title }]));
    },
    /** Let a game stopped in the attached debugger go (a command from the editor must reach it). */
    release(targetId) {
      const rec = attached.get(targetId);
      if (!rec) return Promise.resolve(false);
      return rec.dbg.sendCommand('Debugger.resume', {}).then(() => true, () => false);
    },
    /** Before a window is destroyed: detach, so a stopped page is not torn down mid-pause. */
    detach,
  };
}

/**
 * IPC for the editor: `debugport:set` turns the port on (or off, or onto another port), `play:vscode-release`
 * lets a game stopped in VS Code go. `play` is playWindow.js's view of its windows.
 */
function registerIpc({ ipcMain, play, product }) {
  /** Editor windows that asked for the port: its status goes to them. */
  const subscribers = new Set();
  const send = (contents, payload) => { if (contents && !contents.isDestroyed()) contents.send('play:event', payload); };
  const port = createDebugPort({
    targets: () => play.debugTargets(),
    emit: send,
    broadcast: (payload) => { for (const c of [...subscribers]) { if (c.isDestroyed()) subscribers.delete(c); else send(c, payload); } },
    product,
    log: (line) => { if (process.env.CLEO_DEV === '1') console.log(line); },
    // CLEO_DEBUG_PORT_TRACE=<file>: every protocol message through the port, for diagnosing a debugger.
    trace: process.env.CLEO_DEBUG_PORT_TRACE
      ? (dir, text) => { try { require('fs').appendFileSync(process.env.CLEO_DEBUG_PORT_TRACE, `${Date.now()} ${dir} ${text.slice(0, 400)}\n`); } catch { /* best effort */ } }
      : null,
  });
  play.setDebugPort(port);

  ipcMain.handle('debugport:set', async (event, options) => {
    subscribers.add(event.sender);
    const enabled = !!(options && options.enabled);
    if (!enabled) { await port.close(); return { ok: true, port: 0 }; }
    return port.listen(options.port);
  });
  ipcMain.handle('play:vscode-release', async (event, sessionId) => {
    const target = play.debugTargets().find(t => t.id === String(sessionId));
    if (!target || target.owner !== event.sender) return { ok: false };
    return { ok: await port.release(target.id) };
  });
  return port;
}

module.exports = { acceptKey, encodeFrame, FrameReader, hostAllowed, createDebugPort, registerIpc };

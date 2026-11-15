import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { join } from 'path';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';

/**
 * The game windows' debug port for VS Code (applications/app-kit/desktop/debugPort.js): a stand-in for
 * Chrome's remote debugging endpoint with the game windows as its only targets. Run here in plain Node
 * against a fake window, with Node's own WebSocket as the debugger — the same requests VS Code's js-debug
 * makes: /json/version, the browser socket, Target.setDiscoverTargets, Target.attachToTarget {flatten},
 * then page commands by sessionId.
 */

const DESKTOP = join(__dirname, '..', 'applications', 'app-kit', 'desktop');
const dp = createRequire(import.meta.url)(join(DESKTOP, 'debugPort.js'));

class FakeDebugger extends EventEmitter {
  attachedFlag = false;
  sent: { method: string; params: any; sessionId?: string }[] = [];
  isAttached() { return this.attachedFlag; }
  attach() { this.attachedFlag = true; }
  detach() { this.attachedFlag = false; }
  async sendCommand(method: string, params: any, sessionId?: string) {
    this.sent.push({ method, params, ...(sessionId ? { sessionId } : {}) });
    if (method === 'Fail.me') throw new Error('nope');
    return { echoed: method };
  }
}

function fakeTarget(id = 'aaaabbbbccccdddd') {
  const dbg = new FakeDebugger();
  return {
    id, title: 'Game', url: `app://editor/play.html?session=${id}`, owner: { name: 'editor' }, heldByCleo: false,
    contents: { debugger: dbg, isDestroyed: () => false },
    dbg,
  };
}

let port: any = null;
afterEach(async () => { await port?.close(); port = null; });

async function start(list: any[], events: any[] = []) {
  port = dp.createDebugPort({
    targets: () => list,
    emit: (owner: any, payload: any) => events.push({ owner, ...payload }),
    broadcast: (payload: any) => events.push(payload),
  });
  for (let p = 19339; p < 19400; p++) {
    const r = await port.listen(p);
    if (r.ok) return r.port as number;
  }
  throw new Error('no free port');
}

/** A debugger connection: send commands, read replies and events. */
async function connect(url: string) {
  const ws = new WebSocket(url);
  const inbox: any[] = [];
  const waiters: { test: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  ws.onmessage = (e: MessageEvent) => {
    const m = JSON.parse(String(e.data));
    const i = waiters.findIndex(w => w.test(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m); else inbox.push(m);
  };
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('ws error')); });
  let id = 0;
  const next = (test: (m: any) => boolean, ms = 2000) => {
    const i = inbox.findIndex(test);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise<any>((resolve, reject) => {
      waiters.push({ test, resolve });
      setTimeout(() => reject(new Error('timed out')), ms);
    });
  };
  const call = (method: string, params: any = {}, sessionId?: string) => {
    const msgId = ++id;
    ws.send(JSON.stringify({ id: msgId, method, params, ...(sessionId ? { sessionId } : {}) }));
    return next(m => m.id === msgId);
  };
  return { ws, call, next, close: () => ws.close() };
}

describe('the debug port for VS Code', () => {
  it('answers /json/version and /json/list with the game windows only', async () => {
    const target = fakeTarget();
    const p = await start([target]);
    const version = await (await fetch(`http://127.0.0.1:${p}/json/version`)).json();
    expect(version['Protocol-Version']).toBe('1.3');
    expect(version.webSocketDebuggerUrl).toMatch(new RegExp(`^ws://127\\.0\\.0\\.1:${p}/devtools/browser/`));
    const list = await (await fetch(`http://127.0.0.1:${p}/json/list`)).json();
    expect(list).toEqual([expect.objectContaining({ id: target.id, type: 'page', url: target.url, webSocketDebuggerUrl: `ws://127.0.0.1:${p}/devtools/page/${target.id}` })]);
  });

  it('refuses a Host that is not this machine, and a WebSocket from a web page', async () => {
    const p = await start([fakeTarget()]);
    const http = await import('http');
    const status = (headers: Record<string, string>, path = '/json/version') => new Promise<number>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: p, path, headers }, res => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', () => resolve(-1));
      req.end();
    });
    expect(await status({ Host: 'evil.example:80' })).toBe(403);
    expect(await status({ Host: `localhost:${p}` })).toBe(200);
    const version = await (await fetch(`http://127.0.0.1:${p}/json/version`)).json();
    const path = new URL(version.webSocketDebuggerUrl).pathname;
    const upgrade = (origin?: string) => new Promise<string>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: p, path, headers: {
        Host: `127.0.0.1:${p}`, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...(origin ? { Origin: origin } : {}),
      } });
      req.on('upgrade', (res, socket) => { socket.destroy(); resolve(String(res.statusCode)); });
      req.on('response', res => { res.resume(); resolve(String(res.statusCode)); });
      req.on('error', (e) => resolve(`error ${e.message}`));
      req.end();
    });
    expect(await upgrade('https://evil.example')).toMatch(/403|error/);
    expect(await upgrade()).toBe('101');
  });

  it('lets a debugger find the game window, open a session on it and drive the page', async () => {
    const target = fakeTarget();
    const events: any[] = [];
    const p = await start([target], events);
    const version = await (await fetch(`http://127.0.0.1:${p}/json/version`)).json();
    const c = await connect(version.webSocketDebuggerUrl);
    await c.call('Target.setDiscoverTargets', { discover: true });
    const created = await c.next(m => m.method === 'Target.targetCreated');
    expect(created.params.targetInfo).toMatchObject({ targetId: target.id, type: 'page', url: target.url });
    const attached = await c.call('Target.attachToTarget', { targetId: target.id, flatten: true });
    const sessionId = attached.result.sessionId;
    expect(sessionId).toBeTruthy();
    expect(target.dbg.isAttached()).toBe(true);
    await c.next(m => m.method === 'Target.attachedToTarget' && m.params.sessionId === sessionId);

    // A page command goes to the window's debugger; its reply comes back on the session.
    const r = await c.call('Debugger.enable', {}, sessionId);
    expect(r).toMatchObject({ result: { echoed: 'Debugger.enable' }, sessionId });
    expect(target.dbg.sent.at(-1)).toEqual({ method: 'Debugger.enable', params: {} });
    // A failing one answers with the protocol's error, not silence.
    expect((await c.call('Fail.me', {}, sessionId)).error.message).toBe('nope');

    // Events from the page arrive on the session; a stop is reported to the editor.
    target.dbg.emit('message', {}, 'Debugger.paused', { reason: 'other', callFrames: [] }, '');
    expect(await c.next(m => m.method === 'Debugger.paused')).toMatchObject({ sessionId });
    expect(events).toContainEqual(expect.objectContaining({ type: 'vscode-paused', sessionId: target.id, owner: target.owner }));

    // A child target (a worker) the page auto-attached: its commands carry its own session.
    target.dbg.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'CHILD1', targetInfo: { type: 'worker' } }, '');
    await c.next(m => m.method === 'Target.attachedToTarget' && m.params.sessionId === 'CHILD1');
    await c.call('Runtime.enable', {}, 'CHILD1');
    expect(target.dbg.sent.at(-1)).toEqual({ method: 'Runtime.enable', params: {}, sessionId: 'CHILD1' });
    target.dbg.emit('message', {}, 'Runtime.consoleAPICalled', { type: 'log' }, 'CHILD1');
    expect(await c.next(m => m.method === 'Runtime.consoleAPICalled')).toMatchObject({ sessionId: 'CHILD1' });

    // js-debug's last setup step: the editor may let the game boot.
    await c.call('Runtime.runIfWaitingForDebugger', {}, sessionId);
    expect(events).toContainEqual(expect.objectContaining({ type: 'vscode-ready', sessionId: target.id }));
    expect(events.filter(e => e.type === 'vscode-status').at(-1)).toMatchObject({ listening: true, clients: 1 });

    // The connection closing lets the window go.
    c.close();
    await new Promise(r => setTimeout(r, 100));
    expect(target.dbg.isAttached()).toBe(false);
  });

  it('refuses a window Cleo\'s own debugger holds, and a second debugger on the same window', async () => {
    const held = { ...fakeTarget('1111222233334444'), heldByCleo: true };
    const free = fakeTarget('5555666677778888');
    const p = await start([held, free]);
    const version = await (await fetch(`http://127.0.0.1:${p}/json/version`)).json();
    const a = await connect(version.webSocketDebuggerUrl);
    expect((await a.call('Target.attachToTarget', { targetId: held.id, flatten: true })).error.message).toMatch(/debugged in Cleo/);
    expect((await a.call('Target.attachToTarget', { targetId: free.id, flatten: true })).result.sessionId).toBeTruthy();
    const b = await connect(version.webSocketDebuggerUrl);
    expect((await b.call('Target.attachToTarget', { targetId: free.id, flatten: true })).error.message).toMatch(/Another debugger/);
    expect(port.holds(free.id)).toBe(true);
    expect(port.holds(held.id)).toBe(false);
    a.close(); b.close();
  });

  it('tells a discovering debugger when a game window opens and closes, and detaches from a closed one', async () => {
    const list: any[] = [];
    const p = await start(list);
    const version = await (await fetch(`http://127.0.0.1:${p}/json/version`)).json();
    const c = await connect(version.webSocketDebuggerUrl);
    await c.call('Target.setDiscoverTargets', { discover: true });
    const target = fakeTarget();
    list.push(target);
    port.targetsChanged();
    await c.next(m => m.method === 'Target.targetCreated' && m.params.targetInfo.targetId === target.id);
    const { result } = await c.call('Target.attachToTarget', { targetId: target.id, flatten: true });
    list.length = 0;
    port.targetsChanged();
    await c.next(m => m.method === 'Target.detachedFromTarget' && m.params.sessionId === result.sessionId);
    await c.next(m => m.method === 'Target.targetDestroyed' && m.params.targetId === target.id);
    expect(target.dbg.isAttached()).toBe(false);
    c.close();
  });

  it('lets a game stopped in the debugger go when the editor has a command for it', async () => {
    const target = fakeTarget();
    const p = await start([target]);
    const version = await (await fetch(`http://127.0.0.1:${p}/json/version`)).json();
    const c = await connect(version.webSocketDebuggerUrl);
    await c.call('Target.attachToTarget', { targetId: target.id, flatten: true });
    expect(await port.release(target.id)).toBe(true);
    expect(target.dbg.sent.at(-1)).toEqual({ method: 'Debugger.resume', params: {} });
    expect(await port.release('ffffffffffffffff')).toBe(false);
    c.close();
  });

  it('reports a port in use instead of throwing', async () => {
    const p = await start([fakeTarget()]);
    const other = dp.createDebugPort({ targets: () => [], emit: () => {}, broadcast: () => {} });
    expect(await other.listen(p)).toMatchObject({ ok: false, error: expect.stringMatching(/in use/) });
    expect(await other.listen(80)).toMatchObject({ ok: false });
    await other.close();
  });
});

describe('its WebSocket frames', () => {
  const mask = (opcode: number, text: string, fin = true) => {
    const body = Buffer.from(text);
    const key = Buffer.from([1, 2, 3, 4]);
    const head = body.length < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | body.length])
      : Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 126]), Buffer.from([body.length >> 8, body.length & 0xff])]);
    const masked = Buffer.from(body.map((b, i) => b ^ key[i & 3]));
    return Buffer.concat([head, key, masked]);
  };

  it('reads masked, long, split and fragmented messages, and control frames between fragments', () => {
    const reader = new dp.FrameReader();
    expect(reader.push(mask(1, 'hello')).map((f: any) => f.payload.toString())).toEqual(['hello']);
    const long = 'x'.repeat(70000);
    const frame = Buffer.concat([Buffer.from([0x81, 0x80 | 127]), Buffer.alloc(4), Buffer.from([0, 1, 0x11, 0x70]), Buffer.from([0, 0, 0, 0]), Buffer.from(long)]);
    // Delivered in two pieces.
    expect(reader.push(frame.subarray(0, 100))).toEqual([]);
    expect(reader.push(frame.subarray(100))[0].payload.length).toBe(70000);
    const parts = reader.push(Buffer.concat([mask(1, 'ab', false), mask(9, 'ping'), mask(0, 'cd', true)]));
    expect(parts.map((f: any) => [f.opcode, f.payload.toString()])).toEqual([[9, 'ping'], [1, 'abcd']]);
  });

  it('writes unmasked final frames, and the handshake key RFC 6455 gives', () => {
    expect(dp.encodeFrame(1, 'hi')).toEqual(Buffer.from([0x81, 2, 0x68, 0x69]));
    expect(dp.encodeFrame(1, 'y'.repeat(300)).subarray(0, 4)).toEqual(Buffer.from([0x81, 126, 1, 44]));
    expect(dp.acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
    expect(dp.hostAllowed('127.0.0.1:9339')).toBe(true);
    expect(dp.hostAllowed('localhost:9339')).toBe(true);
    // js-debug's WebSocket names no port.
    expect(dp.hostAllowed('localhost')).toBe(true);
    expect(dp.hostAllowed('[::1]:9339')).toBe(true);
    expect(dp.hostAllowed('evil.com')).toBe(false);
    expect(dp.hostAllowed('localhost.evil.com:9339')).toBe(false);
    expect(dp.hostAllowed('')).toBe(false);
  });

  it('parses', () => {
    expect(() => execFileSync(process.execPath, ['--check', join(DESKTOP, 'debugPort.js')])).not.toThrow();
  });
});

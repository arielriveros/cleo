import { describe, it, expect, beforeEach } from 'vitest';
import {
  WindowPlayController, CLOSE_GRACE_MS, HELLO_TIMEOUT_MS, RELOAD_GRACE_MS,
  type WindowPlayEnv,
} from '../src/features/playWindow/playWindowController';
import type { PlayMessage } from '../src/features/playWindow/protocol';

// The editor side of Play in window, against a fake platform: what it sends, when, and how it decides the
// window is gone. The real platform is windowPlay.ts.

interface Fake {
  env: WindowPlayEnv;
  sent: PlayMessage[];
  log: string[];
  logs: { kind: string; entry: any }[];
  notices: string[];
  /** Deliver a message from the game. */
  deliver(message: any): void;
  /** Fire the lock watch: the page holding the game lock is gone. */
  releaseGameLock(): void;
  windowEvent(event: 'closed' | 'crashed', detail?: string): void;
  advance(ms: number): void;
  ownerHeld: boolean;
  dropped: string[];
  packed: string[];
}

function fakeEnv(options: { popups?: boolean; locks?: boolean; pack?: (data: any) => Promise<number> } = {}): Fake {
  let now = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let timerId = 0;
  let onMessage: ((m: unknown) => void) | null = null;
  let gameGone: (() => void)[] = [];
  let windowCb: ((id: string, e: 'closed' | 'crashed', d?: string) => void) | null = null;
  let session = '';
  const fake: Fake = {
    sent: [], log: [], logs: [], notices: [], ownerHeld: false, dropped: [], packed: [],
    deliver: m => onMessage?.({ to: 'editor', session, ...m }),
    releaseGameLock: () => { const watchers = gameGone; gameGone = []; for (const fn of watchers) fn(); },
    windowEvent: (e, d) => windowCb?.(session, e, d),
    advance(ms) {
      now += ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const due = timers[0];
        if (!due || due.at > now) break;
        timers.shift();
        due.fn();
      }
    },
    env: {
      newSessionId: () => (session = 'aaaabbbbccccdddd'),
      openChannel(cb) {
        onMessage = cb;
        fake.log.push('channel');
        return { post: m => { fake.sent.push(m); }, close: () => { onMessage = null; fake.log.push('channel closed'); } };
      },
      openWindow(id) { fake.log.push(`open ${id}`); return true; },
      closeWindow(id) { fake.log.push(`close ${id}`); },
      focusWindow(id) { fake.log.push(`focus ${id}`); },
      popupsCanBeBlocked: options.popups ?? false,
      pack: async (data, id) => { fake.packed.push(id); fake.log.push('pack'); return options.pack ? options.pack(data) : 100; },
      dropSession: async id => { fake.dropped.push(id); },
      holdOwnerLock() {
        if (options.locks === false) return null;
        fake.ownerHeld = true; fake.log.push('owner lock');
        return () => { fake.ownerHeld = false; };
      },
      watchGameLock(_id, gone) { if (options.locks === false) return false; gameGone.push(gone); return true; },
      onWindowEvent(cb) { windowCb = cb; return () => { windowCb = null; }; },
      emitLog: (kind, entry) => fake.logs.push({ kind, entry }),
      notify: (_tone, message) => fake.notices.push(message),
      log: message => fake.log.push(message),
      now: () => now,
      setTimeout(fn, ms) { const id = ++timerId; timers.push({ at: now + ms, fn, id }); return id; },
      clearTimeout(handle) { const i = timers.findIndex(t => t.id === handle); if (i >= 0) timers.splice(i, 1); },
    },
  };
  return fake;
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const types = (f: Fake) => f.sent.map(m => m.type);
const size = { width: 1280, height: 720, title: 'Game' };

describe('Play in window: the editor side', () => {
  let f: Fake;
  let c: WindowPlayController;
  beforeEach(() => { f = fakeEnv(); c = new WindowPlayController(f.env); });

  it('opens the window inside the click, before the build has even started', async () => {
    let buildCalls = 0;
    let finish!: (data: any) => void;
    c.start(() => { buildCalls++; f.log.push('build'); return new Promise(r => { finish = r; }); }, size);
    // Synchronously: the owner lock first (so the game page queues behind it), then the window.
    expect(f.log.slice(0, 3)).toEqual(['channel', 'owner lock', 'open aaaabbbbccccdddd']);
    expect(c.getSnapshot()).toMatchObject({ status: 'building', active: true, sessionId: 'aaaabbbbccccdddd' });
    expect(buildCalls).toBe(1);
    finish({ scenes: {} });
    await flush(); await flush();
    expect(f.packed).toEqual(['aaaabbbbccccdddd']);
    expect(types(f)).toEqual(['data-ready']);
    expect(c.getSnapshot().status).toBe('starting');
  });

  it('follows the game: hello, booting, running, paused', async () => {
    c.start(async () => ({}), size);
    await flush(); await flush();
    f.deliver({ type: 'hello', state: { phase: 'waiting' } });
    // A page that said hello after the build is told again.
    expect(types(f)).toEqual(['data-ready', 'data-ready']);
    f.deliver({ type: 'state', state: { phase: 'booting' } });
    expect(c.getSnapshot().status).toBe('starting');
    f.deliver({ type: 'state', state: { phase: 'running', scene: 'Crypt' } });
    expect(c.getSnapshot()).toMatchObject({ status: 'running', scene: 'Crypt' });
    c.pause();
    expect(f.sent.at(-1)?.type).toBe('pause');
    f.deliver({ type: 'state', state: { phase: 'paused', scene: 'Crypt' } });
    expect(c.getSnapshot().status).toBe('paused');
  });

  it("puts the game's log rows in the editor's log under ids and a scope of their own, and never its Clear", async () => {
    c.start(async () => ({}), size);
    f.deliver({ type: 'log', ops: [
      { op: 'add', entry: { id: '3', method: 'warn', data: ['low hp'], scope: 'Script', timestamp: 5 } },
      { op: 'update', entry: { id: '4', method: 'log', data: ['fps 60'], scope: 'Perf', timestamp: 6, flushKey: 'fps' } },
      { op: 'clear' },
    ] });
    expect(f.logs).toEqual([
      { kind: 'add', entry: { id: 'game:aaaabbbbccccdddd:3', method: 'warn', data: ['low hp'], scope: 'Game/Script', timestamp: 5 } },
      { kind: 'update', entry: { id: 'game:aaaabbbbccccdddd:4', method: 'log', data: ['fps 60'], scope: 'Game/Perf', timestamp: 6, flushKey: 'game:aaaabbbbccccdddd:fps' } },
    ]);
  });

  it('ignores messages for another session', async () => {
    c.start(async () => ({}), size);
    f.deliver({ type: 'state', state: { phase: 'running' }, session: 'someone-else' });
    expect(c.getSnapshot().status).not.toBe('running');
  });

  it('a page that lets go of its lock and never says hello again was closed', async () => {
    c.start(async () => ({}), size);
    f.deliver({ type: 'hello', state: { phase: 'running' } });
    f.releaseGameLock();
    f.advance(RELOAD_GRACE_MS - 1);
    expect(c.getSnapshot().active).toBe(true);
    f.advance(1);
    expect(c.getSnapshot()).toMatchObject({ status: 'idle', active: false });
    expect(f.ownerHeld).toBe(false);
    expect(f.dropped).toEqual(['aaaabbbbccccdddd']);
  });

  it('a reload (lock let go, then a new hello) keeps the session', async () => {
    c.start(async () => ({}), size);
    f.deliver({ type: 'hello', state: { phase: 'running' } });
    f.deliver({ type: 'bye', reloading: true });
    f.releaseGameLock();
    f.advance(3000);
    f.deliver({ type: 'hello', state: { phase: 'waiting' } });
    f.advance(RELOAD_GRACE_MS * 2);
    expect(c.getSnapshot().active).toBe(true);
  });

  it('a goodbye that is not a reload ends it sooner', async () => {
    c.start(async () => ({}), size);
    f.deliver({ type: 'hello', state: { phase: 'running' } });
    f.releaseGameLock();
    f.deliver({ type: 'bye', reloading: false });
    f.advance(CLOSE_GRACE_MS);
    expect(c.getSnapshot().active).toBe(false);
  });

  it('a game stopped at a breakpoint is NOT closed: silence alone never ends the session', async () => {
    c.start(async () => ({}), size);
    f.deliver({ type: 'hello', state: { phase: 'running' } });
    f.advance(10 * 60 * 1000);
    expect(c.getSnapshot()).toMatchObject({ active: true, status: 'running' });
  });

  it('the desktop shell saying the window closed ends it at once', async () => {
    c.start(async () => ({}), size);
    f.windowEvent('closed');
    expect(c.getSnapshot().active).toBe(false);
  });

  it('a crashed game process fails the session', async () => {
    c.start(async () => ({}), size);
    f.windowEvent('crashed', 'oom');
    expect(c.getSnapshot()).toMatchObject({ status: 'failed', active: false });
    expect(c.getSnapshot().error).toContain('oom');
  });

  it('Stop closes the window, lets the owner lock go and drops the bytes', async () => {
    c.start(async () => ({}), size);
    await flush(); await flush();
    c.stop();
    expect(f.sent.at(-1)?.type).toBe('stop');
    expect(f.log).toContain('close aaaabbbbccccdddd');
    expect(f.ownerHeld).toBe(false);
    expect(f.dropped).toEqual(['aaaabbbbccccdddd']);
    expect(c.getSnapshot()).toMatchObject({ status: 'idle', active: false, sessionId: null });
  });

  it('Play while a game runs brings its window forward instead of starting another', async () => {
    let builds = 0;
    c.start(async () => { builds++; return {}; }, size);
    c.start(async () => { builds++; return {}; }, size);
    expect(builds).toBe(1);
    expect(f.log).toContain('focus aaaabbbbccccdddd');
    expect(f.sent.some(m => m.type === 'focus')).toBe(true);
  });

  it('Restart rebuilds while the old game runs, then reloads the window', async () => {
    let builds = 0;
    const build = async () => { builds++; return {}; };
    c.start(build, size);
    await flush(); await flush();
    f.deliver({ type: 'hello', state: { phase: 'running' } });
    f.sent.length = 0;
    c.restart(build);
    expect(c.getSnapshot().rebuilding).toBe(true);
    // The old game is not told anything until the new one is stored.
    expect(types(f)).toEqual([]);
    await flush(); await flush();
    expect(builds).toBe(2);
    expect(types(f)).toEqual(['restart']);
    expect(c.getSnapshot()).toMatchObject({ rebuilding: false, status: 'starting' });
  });

  it('Restart pressed again mid-build builds once more, and reloads once', async () => {
    let builds = 0;
    let gate!: () => void;
    const build = () => { builds++; return builds === 2 ? new Promise<any>(r => { gate = () => r({}); }) : Promise.resolve({}); };
    c.start(build, size);
    await flush(); await flush();
    f.sent.length = 0;
    c.restart(build);
    c.restart(build);
    c.restart(build);
    gate();
    await flush(); await flush(); await flush(); await flush();
    expect(builds).toBe(3);
    expect(types(f)).toEqual(['restart']);
  });

  it('a failed Restart keeps the game that was running', async () => {
    let fail = false;
    const build = async () => { if (fail) throw new Error('bad script'); return {}; };
    c.start(build, size);
    await flush(); await flush();
    f.deliver({ type: 'state', state: { phase: 'running' } });
    fail = true;
    c.restart(build);
    await flush(); await flush();
    expect(c.getSnapshot()).toMatchObject({ active: true, status: 'running', rebuilding: false });
    expect(f.notices.join(' ')).toContain('bad script');
    expect(f.sent.some(m => m.type === 'restart' || m.type === 'stop')).toBe(false);
  });

  it('a failed first build fails the session and closes the window', async () => {
    c.start(async () => { throw new Error('no scene'); }, size);
    await flush(); await flush();
    expect(c.getSnapshot()).toMatchObject({ status: 'failed', active: false });
    expect(f.log).toContain('close aaaabbbbccccdddd');
    expect(f.dropped).toEqual(['aaaabbbbccccdddd']);
    // Stop dismisses the failure.
    c.stop();
    expect(c.getSnapshot().status).toBe('idle');
  });

  it('the game failing to boot fails the session', async () => {
    c.start(async () => ({}), size);
    f.deliver({ type: 'failed', message: 'WebGPU device lost' });
    expect(c.getSnapshot()).toMatchObject({ status: 'failed' });
    expect(c.getSnapshot().error).toContain('WebGPU device lost');
  });
});

describe('Play in window on the web', () => {
  it('no hello from the popup means the browser blocked it', async () => {
    const f = fakeEnv({ popups: true });
    const c = new WindowPlayController(f.env);
    c.start(async () => ({}), size);
    f.advance(HELLO_TIMEOUT_MS);
    expect(c.getSnapshot().status).toBe('failed');
    expect(f.notices.join(' ')).toMatch(/blocked/i);
  });

  it('a popup that said hello is not a blocked one', async () => {
    const f = fakeEnv({ popups: true });
    const c = new WindowPlayController(f.env);
    c.start(async () => ({}), size);
    f.deliver({ type: 'hello', state: { phase: 'waiting' } });
    f.advance(HELLO_TIMEOUT_MS * 2);
    expect(c.getSnapshot().active).toBe(true);
  });

  it('without Web Locks, a goodbye is what ends it', async () => {
    const f = fakeEnv({ popups: true, locks: false });
    const c = new WindowPlayController(f.env);
    c.start(async () => ({}), size);
    f.deliver({ type: 'hello', state: { phase: 'running' } });
    f.deliver({ type: 'bye', reloading: false });
    f.advance(CLOSE_GRACE_MS);
    expect(c.getSnapshot().active).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { DebugController, READY_TIMEOUT_MS, type DebugEnv } from '../src/features/scriptDebugger/debugController';
import { toggleAt, upsertAt, relocate, renameModule, parseBreakpoints, type ScriptBreakpoint } from '../src/features/scriptDebugger/breakpoints';
import { parseLogMessage, logpointCondition } from '../src/features/scriptDebugger/logpoints';
import { parseDebugPrefs, type DebugPrefs } from '../src/features/scriptDebugger/debugPrefs';
import { hoverExpression } from '../src/features/scriptDebugger/monacoDebug';

// The script debugger's session logic against a fake game window: what it sends over the DevTools
// protocol, and how it reads what comes back. The real relay is app-kit/desktop/playDebugger.js.

const SESSION = 'aaaabbbbccccdddd';
const HERO = 'cleo-script:///Player/Hero.ts';

interface Fake {
  env: DebugEnv;
  sent: { method: string; params?: any }[];
  log: string[];
  breakpoints: ScriptBreakpoint[];
  prefs: DebugPrefs;
  saved: Map<string, string>;
  current: Map<string, string>;
  advance(ms: number): void;
  /** Answers for a method; default {}. */
  answers: Record<string, (params: any) => any>;
}

function fake(): Fake {
  let now = 0;
  let timerId = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let bpCounter = 0;
  const f: Fake = {
    sent: [], log: [], breakpoints: [], prefs: { pauseOnExceptions: true, breakpointsActive: true },
    saved: new Map([['/Player/Hero', 'v1']]), current: new Map(),
    answers: {
      'Debugger.setBreakpointByUrl': () => ({ breakpointId: `cdp${++bpCounter}`, locations: [] }),
    },
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
      async send(_id, method, params) {
        f.sent.push({ method, ...(params ? { params } : {}) });
        const answer = f.answers[method];
        return answer ? answer(params) : {};
      },
      attach: async () => true,
      breakpoints: () => f.breakpoints,
      prefs: () => f.prefs,
      savedSources: () => f.saved,
      currentSource: id => f.current.get(id) ?? f.saved.get(id),
      raiseEditor: () => f.log.push('raise'),
      focusGame: () => f.log.push('focus game'),
      ping: () => f.log.push('ping'),
      reveal: (id, line) => f.log.push(`reveal ${id}:${line}`),
      log: message => f.log.push(message),
      setTimeout(fn, ms) { const id = ++timerId; timers.push({ at: now + ms, fn, id }); return id; },
      clearTimeout(handle) { const i = timers.findIndex(t => t.id === handle); if (i >= 0) timers.splice(i, 1); },
    },
  };
  return f;
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const bp = (moduleId: string, line: number, extra: Partial<ScriptBreakpoint> = {}): ScriptBreakpoint =>
  ({ id: `${moduleId}:${line}`, moduleId, line, enabled: true, ...extra });

/** A controller attached to a session that has built once and parsed Hero.ts as script 7. */
async function attached(f: Fake): Promise<DebugController> {
  const c = new DebugController(f.env);
  c.started(SESSION);
  c.built(SESSION);
  c.onAttached(SESSION);
  await flush(); await flush();
  c.onProtocolEvent(SESSION, 'Debugger.scriptParsed', { scriptId: '7', url: HERO });
  return c;
}

function frame(scriptId: string, line0: number, name = 'onUpdate', id = `f${line0}`) {
  return { callFrameId: id, functionName: name, location: { scriptId, lineNumber: line0, columnNumber: 4 }, url: '', scopeChain: [], this: { type: 'object' } };
}

describe('breakpoints in the game', () => {
  it('sets each enabled breakpoint by its script URL, on the protocol\'s 0-based line', async () => {
    const f = fake();
    f.breakpoints = [bp('/Player/Hero', 12), bp('/Player/Hero', 20, { enabled: false })];
    await attached(f);
    const sets = f.sent.filter(s => s.method === 'Debugger.setBreakpointByUrl');
    expect(sets).toEqual([{ method: 'Debugger.setBreakpointByUrl', params: { url: HERO, lineNumber: 11 } }]);
  });

  it('removes what went and sets what came, and re-sets one whose condition changed', async () => {
    const f = fake();
    f.breakpoints = [bp('/Player/Hero', 12), bp('/Player/Hero', 30)];
    const c = await attached(f);
    f.sent.length = 0;
    f.breakpoints = [bp('/Player/Hero', 12, { condition: 'hp < 0' }), bp('/Player/Hero', 40)];
    await c.requestSync();
    expect(f.sent.map(s => s.method === 'Debugger.removeBreakpoint' ? `remove ${s.params.breakpointId}` : `set ${s.params.lineNumber}${s.params.condition ? ` if ${s.params.condition}` : ''}`))
      .toEqual(['remove cdp1', 'remove cdp2', 'set 11 if hp < 0', 'set 39']);
  });

  it('turns a logpoint into a condition that logs and never stops', async () => {
    const f = fake();
    f.breakpoints = [bp('/Player/Hero', 5, { logMessage: 'hit {other.name}' })];
    await attached(f);
    const condition = f.sent.find(s => s.method === 'Debugger.setBreakpointByUrl')!.params.condition as string;
    expect(condition).toContain('__cleoLogpoint');
    expect(condition.trim().endsWith('false)')).toBe(true);
    // Run it: it calls the hook with the line's URL and line, the text, then the value.
    const calls: unknown[][] = [];
    const other = { name: 'Goblin' };
    new Function('globalThis', 'other', `return ${condition}`)({ __cleoLogpoint: (...a: unknown[]) => calls.push(a) }, other);
    expect(calls).toEqual([[HERO, 5, 'hit ', 'Goblin']]);
  });

  it('keeps a breakpoint where it was in a script edited since the build, until the Restart', async () => {
    const f = fake();
    f.breakpoints = [bp('/Player/Hero', 12)];
    const c = await attached(f);
    f.sent.length = 0;
    // The script is edited: the gutter moves the breakpoint down two lines, and a new one is added.
    f.current.set('/Player/Hero', 'v2');
    f.breakpoints = [{ ...bp('/Player/Hero', 12), line: 14 }, bp('/Player/Hero', 30)];
    c.sourcesChanged();
    await c.requestSync();
    expect(f.sent).toEqual([]);
    expect(c.getSnapshot().staleModules).toEqual(['/Player/Hero']);
    expect(c.getSnapshot().states['/Player/Hero:30']).toBe('stale');
    // Saved and Restarted: the rebuild becomes what runs when its page says hello.
    f.saved = new Map([['/Player/Hero', 'v2']]);
    f.current.clear();
    c.built(SESSION);
    expect(c.getSnapshot().staleModules).toEqual(['/Player/Hero']); // the old page still runs
    c.hello(SESSION);
    await c.requestSync();
    expect(f.sent.map(s => s.method)).toEqual(['Debugger.removeBreakpoint', 'Debugger.setBreakpointByUrl', 'Debugger.setBreakpointByUrl']);
    expect(c.getSnapshot().staleModules).toEqual([]);
  });

  it('marks a breakpoint bound once the protocol resolves it', async () => {
    const f = fake();
    f.breakpoints = [bp('/Player/Hero', 12)];
    const c = await attached(f);
    expect(c.getSnapshot().states['/Player/Hero:12']).toBe('pending');
    c.onProtocolEvent(SESSION, 'Debugger.breakpointResolved', { breakpointId: 'cdp1', location: { scriptId: '7', lineNumber: 11 } });
    expect(c.getSnapshot().states['/Player/Hero:12']).toBe('bound');
  });

  it('lets the first boot wait for the breakpoints, but not for ever', async () => {
    const f = fake();
    const c = new DebugController(f.env);
    c.started(SESSION);
    let ready = false;
    void c.ready(SESSION).then(() => { ready = true; });
    await flush();
    expect(ready).toBe(false);
    f.advance(READY_TIMEOUT_MS);
    await flush();
    expect(ready).toBe(true);
    // Once attached and synced it answers at once.
    c.onAttached(SESSION);
    await flush(); await flush();
    let again = false;
    void c.ready(SESSION).then(() => { again = true; });
    await flush();
    expect(again).toBe(true);
  });
});

describe('a stop', () => {
  it('maps the stop to the script and line, raises the editor and shows the line', async () => {
    const f = fake();
    f.breakpoints = [bp('/Player/Hero', 12)];
    const c = await attached(f);
    c.onProtocolEvent(SESSION, 'Debugger.paused', {
      reason: 'other', hitBreakpoints: ['cdp1'],
      callFrames: [frame('7', 11), frame('99', 300, 'tick', 'engine')],
    });
    const s = c.getSnapshot();
    expect(s.phase).toBe('paused');
    expect(s.paused!.reason).toBe('breakpoint');
    expect(s.paused!.breakpointIds).toEqual(['/Player/Hero:12']);
    expect(s.paused!.frames[0]).toMatchObject({ moduleId: '/Player/Hero', line: 12, column: 5, user: true });
    expect(s.paused!.frames[1]).toMatchObject({ moduleId: null, user: false });
    expect(f.log).toContain('raise');
    expect(f.log).toContain('reveal /Player/Hero:12');
    // The game's audio is hushed and its window says why it froze.
    expect(f.sent.some(m => m.method === 'Debugger.evaluateOnCallFrame' && m.params.expression.includes('__cleoDebug'))).toBe(true);
    expect(f.sent.some(m => m.method === 'Overlay.setPausedInDebuggerMessage' && m.params.message)).toBe(true);
  });

  it('selects the first script frame when engine code a script called threw', async () => {
    const f = fake();
    const c = await attached(f);
    c.onProtocolEvent(SESSION, 'Debugger.paused', {
      reason: 'exception', data: { type: 'object', description: 'Error: engine api threw' },
      callFrames: [frame('99', 1, 'getNode', 'engine'), frame('7', 40)],
    });
    const s = c.getSnapshot();
    expect(s.paused!.reason).toBe('exception');
    expect(s.paused!.exception!.text).toBe('Error: engine api threw');
    expect(s.selectedFrame).toBe(1);
  });

  it('goes on past an exception the user said not to stop at again', async () => {
    const f = fake();
    const c = await attached(f);
    const pause = { reason: 'exception', data: { type: 'object', description: 'TypeError: x' }, callFrames: [frame('7', 40)] };
    c.onProtocolEvent(SESSION, 'Debugger.paused', pause);
    c.ignoreCurrentException();
    expect(f.sent.at(-1)!.method).toBe('Debugger.resume');
    c.onProtocolEvent(SESSION, 'Debugger.resumed', {});
    f.sent.length = 0;
    c.onProtocolEvent(SESSION, 'Debugger.paused', pause);
    expect(c.getSnapshot().phase).toBe('running');
    expect(f.sent).toEqual([{ method: 'Debugger.resume' }]);
  });

  it('resumes into the game window and asks the game for its state', async () => {
    const f = fake();
    const c = await attached(f);
    c.onProtocolEvent(SESSION, 'Debugger.paused', { reason: 'other', callFrames: [frame('7', 3)] });
    c.resume();
    expect(f.log).toContain('focus game');
    c.onProtocolEvent(SESSION, 'Debugger.resumed', {});
    expect(c.getSnapshot().phase).toBe('running');
    expect(f.log).toContain('ping');
    expect(f.sent.some(m => m.method === 'Runtime.evaluate' && m.params.expression.includes('resumed'))).toBe(true);
  });

  it('treats a step that stops again as a step, and one that runs on as running', async () => {
    const f = fake();
    const c = await attached(f);
    c.onProtocolEvent(SESSION, 'Debugger.paused', { reason: 'other', callFrames: [frame('7', 3)] });
    f.log.length = 0;
    c.stepOver();
    c.onProtocolEvent(SESSION, 'Debugger.resumed', {});
    c.onProtocolEvent(SESSION, 'Debugger.paused', { reason: 'other', callFrames: [frame('7', 4)] });
    expect(c.getSnapshot().paused!.reason).toBe('step');
    // A step is not a new stop: the editor is not raised again, the game not asked.
    expect(f.log).not.toContain('raise');
    expect(f.log).not.toContain('ping');
    c.stepOut();
    c.onProtocolEvent(SESSION, 'Debugger.resumed', {});
    f.advance(1000);
    expect(f.log).toContain('ping');
  });

  it('lets a stopped game go to hear a command, and stops at breakpoints again after', async () => {
    const f = fake();
    const c = await attached(f);
    c.onProtocolEvent(SESSION, 'Debugger.paused', { reason: 'other', callFrames: [frame('7', 3)] });
    f.sent.length = 0;
    const heard: string[] = [];
    c.whenRunning(() => heard.push('pause'), false);
    await flush(); await flush();
    expect(f.sent.map(s => s.method)).toEqual(['Debugger.setSkipAllPauses', 'Debugger.resume']);
    expect(heard).toEqual(['pause']);
    f.advance(1000);
    expect(f.sent.at(-1)).toEqual({ method: 'Debugger.setSkipAllPauses', params: { skip: false } });
  });

  it('holds breakpoints off across a Restart\'s reload until the new page says hello', async () => {
    const f = fake();
    const c = await attached(f);
    c.onProtocolEvent(SESSION, 'Debugger.paused', { reason: 'other', callFrames: [frame('7', 3)] });
    c.whenRunning(() => {}, true);
    await flush(); await flush();
    f.advance(5000);
    expect(f.sent.filter(s => s.method === 'Debugger.setSkipAllPauses').map(s => s.params.skip)).toEqual([true]);
    c.hello(SESSION);
    expect(f.sent.at(-1)).toEqual({ method: 'Debugger.setSkipAllPauses', params: { skip: false } });
  });

  it('sends a command straight through when the game is not stopped', async () => {
    const f = fake();
    const c = await attached(f);
    const heard: string[] = [];
    c.whenRunning(() => heard.push('restart'), true);
    expect(heard).toEqual(['restart']);
  });

  it('forgets the session\'s breakpoints when the debugger lets go, and reattaches', async () => {
    const f = fake();
    f.breakpoints = [bp('/Player/Hero', 12)];
    const c = await attached(f);
    c.onDetached(SESSION, 'target closed');
    expect(c.getSnapshot().phase).toBe('detached');
    expect(c.getSnapshot().states['/Player/Hero:12']).toBe('pending');
    await c.reattach();
    expect(c.getSnapshot().phase).toBe('attaching');
    f.sent.length = 0;
    c.onAttached(SESSION);
    await flush(); await flush();
    expect(f.sent.filter(s => s.method === 'Debugger.setBreakpointByUrl')).toHaveLength(1);
  });

  it('ignores another session\'s events', async () => {
    const f = fake();
    const c = await attached(f);
    c.onProtocolEvent('ffffffffffffffff', 'Debugger.paused', { reason: 'other', callFrames: [frame('7', 3)] });
    expect(c.getSnapshot().phase).toBe('running');
  });
});

describe('breakpoint store operations', () => {
  it('toggles one breakpoint per line', () => {
    const one = toggleAt([], '/A', 3);
    expect(one).toHaveLength(1);
    expect(toggleAt(one, '/A', 3)).toEqual([]);
    expect(toggleAt(one, '/A', 4)).toHaveLength(2);
  });

  it('turns a breakpoint into a logpoint and back, never holding both', () => {
    let list = upsertAt([], '/A', 3, { condition: 'x > 1' });
    list = upsertAt(list, '/A', 3, { logMessage: 'x is {x}', condition: undefined });
    expect(list).toHaveLength(1);
    expect(list[0].logMessage).toBe('x is {x}');
    expect('condition' in list[0]).toBe(false);
  });

  it('moves breakpoints with their lines, merging two that met', () => {
    const list = [bp('/A', 3), bp('/A', 9), bp('/B', 9)];
    const moved = relocate(list, '/A', new Map([['/A:3', 5], ['/A:9', 5]]));
    expect(moved.map(b => `${b.moduleId}:${b.line}`)).toEqual(['/A:5', '/B:9']);
    expect(relocate(list, '/A', new Map([['/A:3', 3]]))).toBe(list);
  });

  it('follows a script that moved', () => {
    expect(renameModule([bp('/A', 3)], '/A', '/Shared/A')[0].moduleId).toBe('/Shared/A');
  });

  it('reads a stored list, dropping what is not a breakpoint', () => {
    const raw = JSON.stringify([bp('/A', 3), { id: 'x' }, bp('/A', 0), { ...bp('/B', 2), condition: '' }]);
    expect(parseBreakpoints(raw).map(b => b.id)).toEqual(['/A:3', '/B:2']);
    expect(parseBreakpoints('not json')).toEqual([]);
  });
});

describe('logpoint messages', () => {
  it('splits text from {expressions}, with {{ }} as literal braces', () => {
    expect(parseLogMessage('hit {other.name} for {damage}')).toEqual([{ text: 'hit ' }, { expr: 'other.name' }, { text: ' for ' }, { expr: 'damage' }]);
    expect(parseLogMessage('{{literal}} {({ a: 1 }).a}')).toEqual([{ text: '{literal} ' }, { expr: '({ a: 1 }).a' }]);
    expect(parseLogMessage('open {brace')).toEqual([{ text: 'open {brace' }]);
  });

  it('logs an expression that throws as its error, and the rest still', () => {
    const calls: unknown[][] = [];
    const condition = logpointCondition('{missing.x} and {1 + 1}', HERO, 3);
    const result = new Function('globalThis', `return ${condition}`)({ __cleoLogpoint: (...a: unknown[]) => calls.push(a) });
    expect(result).toBe(false);
    expect(calls[0][2]).toMatch(/^<ReferenceError/);
    expect(calls[0].slice(3)).toEqual([' and ', 2]);
  });

  it('escapes the text it embeds', () => {
    const calls: unknown[][] = [];
    const condition = logpointCondition('quote " backtick ` and ${not}', HERO, 3);
    new Function('globalThis', `return ${condition}`)({ __cleoLogpoint: (...a: unknown[]) => calls.push(a) });
    expect(calls[0][2]).toBe('quote " backtick ` and $');
  });
});

describe('debugger switches', () => {
  it('stops on exceptions unless told otherwise', () => {
    expect(parseDebugPrefs(null)).toEqual({ pauseOnExceptions: true, breakpointsActive: true });
    expect(parseDebugPrefs('{"pauseOnExceptions":false}')).toEqual({ pauseOnExceptions: false, breakpointsActive: true });
    expect(parseDebugPrefs('garbage')).toEqual({ pauseOnExceptions: true, breakpointsActive: true });
  });
});

describe('hover values', () => {
  const at = (line: string, word: string) => {
    const start = line.indexOf(word);
    return hoverExpression(line, start, start + word.length);
  };
  it('evaluates the member chain up to the word under the mouse', () => {
    expect(at('    this.target.position.x += 1', 'position')).toBe('this.target.position');
    expect(at('    const speed = this.speed * dt', 'dt')).toBe('dt');
    expect(at('    a?.b', 'b')).toBe('a?.b');
    expect(at('    this.go()', 'this')).toBe('this');
  });
  it('never evaluates a call, an index or a keyword', () => {
    expect(at('    foo().bar', 'bar')).toBeNull();
    expect(at('    list[0].name', 'name')).toBeNull();
    expect(at('    return x', 'return')).toBeNull();
  });
});

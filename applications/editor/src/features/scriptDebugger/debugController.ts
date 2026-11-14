// The script debugger: Cleo's own breakpoints, stepping and variables for a game playing in a window.
//
// The game runs in a renderer process of its own (Play in window), so a script stopped at a breakpoint
// stops only the game; the editor stays live and shows where. The editor drives that window over the
// DevTools protocol, which the desktop shell's main process relays (app-kit/desktop/playDebugger.js) —
// a web page cannot reach another page's debugger, so this exists on the desktop only.
//
// Scripts are named and line-exact at runtime (the engine's scriptUrls.ts): the script at module id
// `/Player/Hero` runs as `cleo-script:///Player/Hero.ts`, and its line N is protocol line N-1. So a gutter
// breakpoint is `setBreakpointByUrl(url, line - 1)`, and a stopped frame maps back by the same rule, with no
// source map. Engine code is ignored by the session (blackboxed): stepping stays in scripts, Pause lands on
// the next script line, and only exceptions thrown in or through script code stop the game.
//
// Everything platform-specific comes in through `DebugEnv`, so the session logic is testable.

import { isScriptUrl, moduleIdOfScriptUrl, scriptSourceUrl } from 'cleo';
import type { CdpCallFrame, CdpEvaluateResult, CdpPausedEvent, CdpPropertyDescriptor, CdpRemoteObject, CdpScope } from './cdp';
import { describeRemote } from './cdp';
import type { ScriptBreakpoint } from './breakpoints';
import type { DebugPrefs } from './debugPrefs';
import { logpointCondition } from './logpoints';

export type DebugPhase = 'off' | 'attaching' | 'running' | 'paused' | 'detached';

export interface DebugFrame {
  callFrameId: string;
  functionName: string;
  url: string | null;
  /** The script's module id; null for engine code and inline scripts. */
  moduleId: string | null;
  /** A user script's frame (cleo-script / cleo-inline), as opposed to engine code. */
  user: boolean;
  /** 1-based, the author's own line. */
  line: number;
  /** 1-based, approximate (types are stripped without padding). */
  column: number;
  scopes: CdpScope[];
  thisObject: CdpRemoteObject;
}

export type PauseReason = 'breakpoint' | 'exception' | 'step' | 'pause' | 'other';

export interface DebugPause {
  reason: PauseReason;
  /** What was thrown, for an exception stop. */
  exception?: { text: string; object?: CdpRemoteObject };
  frames: DebugFrame[];
  /** The breakpoints (our ids) that stopped it. */
  breakpointIds: string[];
}

/**
 * Where a breakpoint stands in the running game:
 * bound — in, on a line that runs; pending — sent, its script not parsed yet (or nothing runs there);
 * stale — its script changed since the game was built, so it waits for a Restart; disabled / inactive —
 * switched off (this one, or all of them).
 */
export type BreakpointState = 'bound' | 'pending' | 'stale' | 'disabled' | 'inactive';

export interface DebugSnapshot {
  phase: DebugPhase;
  sessionId: string | null;
  paused: DebugPause | null;
  /** Index into `paused.frames`: the frame the panel and the editor show. */
  selectedFrame: number;
  /** Pause was asked for: the game stops at the next script line that runs. */
  pauseRequested: boolean;
  detachReason?: string;
  /** Per breakpoint id, during a session. */
  states: Readonly<Record<string, BreakpointState>>;
  /** Scripts whose text differs from what the running game was built from. */
  staleModules: readonly string[];
  /** The node a user frame's `this` is, by call frame id: `Player`. */
  frameNodes: Readonly<Record<string, string>>;
}

export interface DebugEnv {
  /** One protocol command to the session's game window. Rejects with the protocol's error. */
  send(sessionId: string, method: string, params?: object): Promise<any>;
  /** Attach the session again (after it was lost). */
  attach(sessionId: string, options: { pauseOnExceptions: boolean }): Promise<boolean>;
  breakpoints(): readonly ScriptBreakpoint[];
  prefs(): DebugPrefs;
  /** The script sources a build packs (saved ones), by module id — snapshotted when a build finishes. */
  savedSources(): ReadonlyMap<string, string>;
  /** A script's text in the editor now: an open tab's buffer, else what is saved. */
  currentSource(moduleId: string): string | undefined;
  /** Bring the editor forward: the game stopped while the player was in its window. */
  raiseEditor(): void;
  focusGame(sessionId: string): void;
  /** Ask the game for its state again (Play in window's controller). */
  ping(): void;
  /** Show a script at a line in the built-in editor. */
  reveal(moduleId: string, line: number): void;
  log(message: string): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** How long a first boot waits for the debugger before it goes ahead without it. */
export const READY_TIMEOUT_MS = 1500;
/** A step that has not stopped again this soon ran on into the game: it is running. */
const STEP_SETTLE_MS = 150;
/** After a command was let through a stop, breakpoints come back on this much later. */
const RELEASE_MS = 400;

const OBJECT_GROUP = 'cleo-debug';
const PAUSED_MESSAGE = 'Paused in the Cleo editor';

interface Binding {
  cdpId: string;
  /** What it was set with: a change means it must be set again. */
  key: string;
  resolved: boolean;
}

const OFF: DebugSnapshot = {
  phase: 'off', sessionId: null, paused: null, selectedFrame: 0, pauseRequested: false,
  states: {}, staleModules: [], frameNodes: {},
};

function bindingKey(b: ScriptBreakpoint): string {
  return `${b.line}\u0000${b.condition ?? ''}\u0000${b.logMessage ?? ''}`;
}

export class DebugController {
  private snapshot: DebugSnapshot = OFF;
  private readonly listeners = new Set<() => void>();
  private sessionId: string | null = null;
  /** scriptId -> URL, for the user scripts the game parsed (only those reach here). */
  private readonly scripts = new Map<string, string>();
  private readonly bound = new Map<string, Binding>();
  /** What the running game was built from, by module id. */
  private shipped = new Map<string, string>();
  /** A Restart's build, waiting for its page. */
  private nextShipped: Map<string, string> | null = null;
  private builtOnce = false;
  private readyWaiters: (() => void)[] = [];
  private synced = false;
  private syncing: Promise<void> = Promise.resolve();
  private stepping = false;
  private stepTimer: unknown = null;
  /** A command is being let through a stop: the resume it causes is not the user's. */
  private releasing = false;
  private skipUntilHello = false;
  /** Exceptions the user said not to stop at again, this session: `url:line`. */
  private readonly ignored = new Set<string>();

  constructor(private readonly env: DebugEnv) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): DebugSnapshot => this.snapshot;

  private set(patch: Partial<DebugSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  private send(method: string, params?: object): Promise<any> {
    if (!this.sessionId) return Promise.reject(new Error('No debug session'));
    return this.env.send(this.sessionId, method, params);
  }

  private get live(): boolean {
    return this.snapshot.phase === 'running' || this.snapshot.phase === 'paused';
  }

  // ---- Session lifecycle (Play in window's hooks) ----------------------------------------------------

  /** A game window is opening; its debugger session attaches when the page commits. */
  started(sessionId: string): void {
    this.reset();
    this.sessionId = sessionId;
    this.set({ ...OFF, phase: 'attaching', sessionId });
  }

  /** A build finished: the game is about to be what the editor's saved scripts are now. */
  built(sessionId: string): void {
    if (sessionId !== this.sessionId) return;
    const sources = new Map(this.env.savedSources());
    if (!this.builtOnce) {
      // The first build: no game ran yet, so this IS what will run.
      this.builtOnce = true;
      this.shipped = sources;
      this.refreshStates();
      return;
    }
    // A Restart's build: the game running now is still the old one until the window reloads, and its
    // breakpoints must stay on the old lines until then. The new page's hello swaps them.
    this.nextShipped = sources;
  }

  /** Resolves once the debugger is attached and its breakpoints are in, or after READY_TIMEOUT_MS. */
  ready(sessionId: string): Promise<void> {
    if (sessionId !== this.sessionId || this.synced || this.snapshot.phase === 'detached') return Promise.resolve();
    return new Promise<void>(resolve => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      this.readyWaiters.push(finish);
      this.env.setTimeout(finish, READY_TIMEOUT_MS);
    });
  }

  /**
   * A game page said hello: a new page, so new script ids — and after a Restart, the rebuilt game, so what
   * was stale is current again and moved breakpoints go to their new lines (before it boots: the hello
   * comes first).
   */
  hello(sessionId: string): void {
    if (sessionId !== this.sessionId) return;
    this.scripts.clear();
    if (this.nextShipped) {
      this.shipped = this.nextShipped;
      this.nextShipped = null;
      void this.requestSync();
    }
    if (this.skipUntilHello) {
      this.skipUntilHello = false;
      void this.send('Debugger.setSkipAllPauses', { skip: false }).catch(() => {});
    }
  }

  /** Run `send` once the game can hear it: let a stopped game go first (see WindowPlayDebugHooks). */
  whenRunning(send: () => void, reloads: boolean): void {
    if (this.snapshot.phase !== 'paused') { send(); return; }
    void this.release(send, reloads);
  }

  ended(sessionId: string): void {
    if (sessionId !== this.sessionId) return;
    this.reset();
    this.set(OFF);
  }

  private reset(): void {
    if (this.stepTimer !== null) this.env.clearTimeout(this.stepTimer);
    this.stepTimer = null;
    this.sessionId = null;
    this.scripts.clear();
    this.bound.clear();
    this.ignored.clear();
    this.shipped = new Map();
    this.nextShipped = null;
    this.builtOnce = false;
    this.synced = false;
    this.stepping = false;
    this.releasing = false;
    this.skipUntilHello = false;
    for (const finish of this.readyWaiters.splice(0)) finish();
  }

  /** The session was lost (or never came): attach again. */
  async reattach(): Promise<void> {
    const id = this.sessionId;
    if (!id || this.live || this.snapshot.phase === 'attaching') return;
    this.set({ phase: 'attaching', detachReason: undefined });
    const ok = await this.env.attach(id, { pauseOnExceptions: this.env.prefs().pauseOnExceptions }).catch(() => false);
    if (!ok && this.sessionId === id) this.set({ phase: 'detached', detachReason: 'could not attach' });
  }

  // ---- Events from the game window -------------------------------------------------------------------

  onAttached(sessionId: string): void {
    if (sessionId !== this.sessionId) return;
    this.set({ phase: 'running', detachReason: undefined });
    void (async () => {
      try {
        if (!this.env.prefs().breakpointsActive) await this.send('Debugger.setBreakpointsActive', { active: false });
      } catch { /* the sync below reports what matters */ }
      await this.requestSync();
      this.synced = true;
      for (const finish of this.readyWaiters.splice(0)) finish();
    })();
  }

  onDetached(sessionId: string, reason: string): void {
    if (sessionId !== this.sessionId) return;
    this.bound.clear();
    this.scripts.clear();
    this.synced = false;
    for (const finish of this.readyWaiters.splice(0)) finish();
    this.set({ phase: 'detached', paused: null, pauseRequested: false, detachReason: reason });
    this.refreshStates();
  }

  onProtocolEvent(sessionId: string, method: string, params: any): void {
    if (sessionId !== this.sessionId) return;
    switch (method) {
      case 'Debugger.scriptParsed':
        if (params && isScriptUrl(params.url)) this.scripts.set(String(params.scriptId), params.url);
        break;
      case 'Debugger.breakpointResolved': {
        for (const binding of this.bound.values()) if (binding.cdpId === params?.breakpointId) binding.resolved = true;
        this.refreshStates();
        break;
      }
      case 'Debugger.paused':
        this.onPaused(params as CdpPausedEvent);
        break;
      case 'Debugger.resumed':
        this.onResumed();
        break;
    }
  }

  private frameOf(f: CdpCallFrame): DebugFrame {
    const url = this.scripts.get(f.location.scriptId) ?? (f.url || null);
    return {
      callFrameId: f.callFrameId,
      functionName: f.functionName,
      url,
      moduleId: moduleIdOfScriptUrl(url),
      user: isScriptUrl(url),
      line: f.location.lineNumber + 1,
      column: (f.location.columnNumber ?? 0) + 1,
      scopes: f.scopeChain ?? [],
      thisObject: f.this,
    };
  }

  private onPaused(params: CdpPausedEvent): void {
    if (this.stepTimer !== null) { this.env.clearTimeout(this.stepTimer); this.stepTimer = null; }
    const frames = (params.callFrames ?? []).map(f => this.frameOf(f));
    const firstUser = frames.findIndex(f => f.user);
    const exception = params.reason === 'exception' || params.reason === 'promiseRejection';
    if (exception) {
      const at = frames[firstUser];
      // Only exceptions in or through scripts stop the game (engine code is ignored), and not one the user
      // waved through.
      if (!at || this.ignored.has(`${at.url}:${at.line}`)) {
        void this.send('Debugger.resume').catch(() => {});
        return;
      }
    }
    const byCdp = new Map([...this.bound].map(([id, b]) => [b.cdpId, id]));
    const breakpointIds = (params.hitBreakpoints ?? []).map(id => byCdp.get(id)).filter((id): id is string => !!id);
    const reason: PauseReason = exception ? 'exception'
      : breakpointIds.length ? 'breakpoint'
      : this.stepping ? 'step'
      : this.snapshot.pauseRequested ? 'pause'
      : 'other';
    const pause: DebugPause = {
      reason, frames, breakpointIds,
      ...(exception ? { exception: { text: params.data?.description ?? describeRemote(params.data), ...(params.data ? { object: params.data } : {}) } } : {}),
    };
    const wasStepping = this.stepping;
    this.stepping = false;
    this.set({ phase: 'paused', paused: pause, selectedFrame: Math.max(0, firstUser), pauseRequested: false, frameNodes: {} });

    const top = frames[firstUser];
    if (top?.moduleId) this.env.reveal(top.moduleId, top.line);
    if (!wasStepping) {
      this.env.raiseEditor();
      // While it is stopped the game's music would play on over a frozen frame, and its window should say
      // why it froze. Both are best effort.
      if (frames[0]) void this.send('Debugger.evaluateOnCallFrame', {
        callFrameId: frames[0].callFrameId, expression: 'globalThis.__cleoDebug && globalThis.__cleoDebug.paused()', silent: true,
      }).catch(() => {});
      void this.send('Overlay.setPausedInDebuggerMessage', { message: PAUSED_MESSAGE }).catch(() => {});
    }
    void this.nameFrameNodes(pause);
  }

  /** `this.name` for each script frame, shown beside it in the call stack. */
  private async nameFrameNodes(pause: DebugPause): Promise<void> {
    const names: Record<string, string> = {};
    for (const frame of pause.frames.filter(f => f.user).slice(0, 12)) {
      try {
        const r: CdpEvaluateResult = await this.send('Debugger.evaluateOnCallFrame', {
          callFrameId: frame.callFrameId, expression: 'this && typeof this.name === "string" ? this.name : undefined',
          silent: true, returnByValue: true, throwOnSideEffect: true,
        });
        if (typeof r?.result?.value === 'string') names[frame.callFrameId] = r.result.value;
      } catch { /* a frame that cannot say is shown without */ }
      if (this.snapshot.paused !== pause) return;
    }
    if (Object.keys(names).length) this.set({ frameNodes: names });
  }

  private onResumed(): void {
    this.set({ phase: 'running', paused: null, frameNodes: {} });
    void this.send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(() => {});
    if (this.stepping) {
      // A step resumes, then stops again a moment later. If it does not, it ran on into the game.
      this.stepTimer = this.env.setTimeout(() => {
        this.stepTimer = null;
        this.stepping = false;
        this.afterRunning();
      }, STEP_SETTLE_MS);
      return;
    }
    this.afterRunning();
  }

  /** The game runs again: its music back, the window's paused banner gone, and its state asked for. */
  private afterRunning(): void {
    void this.send('Runtime.evaluate', { expression: 'globalThis.__cleoDebug && globalThis.__cleoDebug.resumed()', silent: true }).catch(() => {});
    void this.send('Overlay.setPausedInDebuggerMessage', {}).catch(() => {});
    // Whatever the game said while it was stopped never arrived.
    this.env.ping();
  }

  // ---- Breakpoints -----------------------------------------------------------------------------------

  private isStale(moduleId: string): boolean {
    const shipped = this.shipped.get(moduleId);
    if (shipped === undefined) return false;
    const current = this.env.currentSource(moduleId);
    return current !== undefined && current !== shipped;
  }

  /** The store changed (or a script's text did): bring the game's breakpoints in line. */
  requestSync(): Promise<void> {
    this.syncing = this.syncing.then(() => this.sync()).catch(e => this.env.log(`Breakpoints could not be set: ${e?.message ?? e}`));
    return this.syncing;
  }

  /** A script's text changed in the editor: only what is stale changes. */
  sourcesChanged(): void {
    if (this.live) void this.requestSync();
    else this.refreshStates();
  }

  private async sync(): Promise<void> {
    if (!this.live) { this.refreshStates(); return; }
    const wanted = new Map(this.env.breakpoints().filter(b => b.enabled).map(b => [b.id, b]));
    for (const [id, binding] of [...this.bound]) {
      const b = wanted.get(id);
      // In a script changed since the build, a breakpoint stays where it was set: that line is still right
      // for the code that runs. Only removing it (or switching it off) applies at once.
      if (b && (this.isStale(b.moduleId) || bindingKey(b) === binding.key)) continue;
      this.bound.delete(id);
      await this.send('Debugger.removeBreakpoint', { breakpointId: binding.cdpId }).catch(() => {});
    }
    for (const b of wanted.values()) {
      if (this.bound.has(b.id) || this.isStale(b.moduleId)) continue;
      const url = scriptSourceUrl(b.moduleId);
      const condition = b.logMessage ? logpointCondition(b.logMessage, url, b.line) : b.condition;
      try {
        const r = await this.send('Debugger.setBreakpointByUrl', { url, lineNumber: b.line - 1, ...(condition ? { condition } : {}) });
        this.bound.set(b.id, { cdpId: r.breakpointId, key: bindingKey(b), resolved: (r.locations?.length ?? 0) > 0 });
      } catch (e: any) {
        this.env.log(`A breakpoint at ${url}:${b.line} could not be set: ${e?.message ?? e}`);
      }
      if (!this.live) break;
    }
    this.refreshStates();
  }

  private refreshStates(): void {
    const active = this.env.prefs().breakpointsActive;
    const inSession = this.snapshot.phase !== 'off';
    const states: Record<string, BreakpointState> = {};
    const stale = new Set<string>();
    for (const b of this.env.breakpoints()) {
      if (!inSession) continue;
      const isStale = this.isStale(b.moduleId);
      if (isStale) stale.add(b.moduleId);
      const binding = this.bound.get(b.id);
      states[b.id] = !b.enabled ? 'disabled'
        : !active ? 'inactive'
        : binding ? (binding.resolved ? 'bound' : 'pending')
        : isStale ? 'stale'
        : 'pending';
    }
    for (const id of this.shipped.keys()) if (inSession && this.isStale(id)) stale.add(id);
    this.set({ states, staleModules: [...stale].sort() });
  }

  setBreakpointsActive(active: boolean): void {
    if (this.live) void this.send('Debugger.setBreakpointsActive', { active }).catch(() => {});
    this.refreshStates();
  }

  setPauseOnExceptions(on: boolean): void {
    if (this.live) void this.send('Debugger.setPauseOnExceptions', { state: on ? 'all' : 'none' }).catch(() => {});
  }

  // ---- Stepping --------------------------------------------------------------------------------------

  /** Continue. The game window comes forward again: the player was playing it. */
  resume(): void {
    if (this.snapshot.phase !== 'paused' || !this.sessionId) return;
    void this.send('Debugger.resume').catch(() => {});
    this.env.focusGame(this.sessionId);
  }

  private step(method: 'Debugger.stepOver' | 'Debugger.stepInto' | 'Debugger.stepOut'): void {
    if (this.snapshot.phase !== 'paused') return;
    this.stepping = true;
    void this.send(method).catch(() => { this.stepping = false; });
  }

  stepOver(): void { this.step('Debugger.stepOver'); }
  stepInto(): void { this.step('Debugger.stepInto'); }
  stepOut(): void { this.step('Debugger.stepOut'); }

  /** Stop at the next script line that runs. */
  pause(): void {
    if (this.snapshot.phase !== 'running') return;
    this.set({ pauseRequested: true });
    void this.send('Debugger.pause').catch(() => this.set({ pauseRequested: false }));
  }

  /** Let a stopped game go to run one command, then stop at breakpoints again. */
  private async release(fn: () => void, reloads: boolean): Promise<void> {
    try {
      await this.send('Debugger.setSkipAllPauses', { skip: true });
      this.releasing = true;
      await this.send('Debugger.resume');
    } catch { /* the command goes anyway */ }
    this.releasing = false;
    fn();
    if (reloads) { this.skipUntilHello = true; return; }
    this.env.setTimeout(() => { void this.send('Debugger.setSkipAllPauses', { skip: false }).catch(() => {}); }, RELEASE_MS);
  }

  /** Don't stop at this exception's line again this session; go on. */
  ignoreCurrentException(): void {
    const pause = this.snapshot.paused;
    if (!pause || pause.reason !== 'exception') return;
    const at = pause.frames.find(f => f.user);
    if (at) this.ignored.add(`${at.url}:${at.line}`);
    this.resume();
  }

  selectFrame(index: number): void {
    const pause = this.snapshot.paused;
    if (!pause || index < 0 || index >= pause.frames.length) return;
    this.set({ selectedFrame: index });
    const frame = pause.frames[index];
    if (frame.moduleId) this.env.reveal(frame.moduleId, frame.line);
  }

  // ---- Inspection ------------------------------------------------------------------------------------

  /** An object's own properties (a scope, `this`, an expanded value). */
  async properties(objectId: string): Promise<CdpPropertyDescriptor[]> {
    const r = await this.send('Runtime.getProperties', { objectId, ownProperties: true, generatePreview: true });
    return (r?.result ?? []) as CdpPropertyDescriptor[];
  }

  /**
   * Evaluate in the selected frame. `hover`: for a value under the mouse — no side effects allowed, no
   * exception reported to the page.
   */
  async evaluate(expression: string, options: { hover?: boolean; frame?: number } = {}): Promise<CdpEvaluateResult | null> {
    const pause = this.snapshot.paused;
    const frame = pause?.frames[options.frame ?? this.snapshot.selectedFrame];
    if (!frame) return null;
    return this.send('Debugger.evaluateOnCallFrame', {
      callFrameId: frame.callFrameId, expression, objectGroup: OBJECT_GROUP, generatePreview: true,
      ...(options.hover ? { silent: true, throwOnSideEffect: true, timeout: 200 } : {}),
    });
  }
}

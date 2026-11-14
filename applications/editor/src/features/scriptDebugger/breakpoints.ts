// The project's script breakpoints: set in the script editor's gutter, listed in the Debugger panel, sent
// to the game window by the debugger (debugController.ts) when it plays in a window.
//
// Per project (they name the project's scripts) and per machine (a debugging session is a person's, not
// the project's): localStorage under the project's prefix, never in a project file or bundle. Keyed by
// module id — the script's path — which is also what its runtime URL names (cleo-script:///Player/Hero.ts),
// so a breakpoint survives the script being reopened, and follows the path the game runs it under.

import { useSyncExternalStore } from 'react';
import { lsKey, LS_KEYS } from '../../utils/lsScope';

export interface ScriptBreakpoint {
  id: string;
  /** The script's module id: `/Player/Hero`. */
  moduleId: string;
  /** 1-based, in the author's source. */
  line: number;
  enabled: boolean;
  /** Stop only when this expression is truthy (evaluated where the line runs). */
  condition?: string;
  /** A logpoint: log this message (`{expr}` interpolates) and never stop. */
  logMessage?: string;
}

// ---- Pure operations, for the store and the tests --------------------------------------------------

let nextId = 0;
function freshId(): string {
  return `bp${Date.now().toString(36)}${(nextId++).toString(36)}`;
}

/** One breakpoint per line of a script: toggling a line with one removes it, else adds a plain one. */
export function toggleAt(list: readonly ScriptBreakpoint[], moduleId: string, line: number): ScriptBreakpoint[] {
  const existing = list.find(b => b.moduleId === moduleId && b.line === line);
  if (existing) return list.filter(b => b !== existing);
  return [...list, { id: freshId(), moduleId, line, enabled: true }];
}

/** Add or replace the breakpoint on a line with these settings. */
export function upsertAt(list: readonly ScriptBreakpoint[], moduleId: string, line: number, patch: Partial<Omit<ScriptBreakpoint, 'id' | 'moduleId' | 'line'>>): ScriptBreakpoint[] {
  const existing = list.find(b => b.moduleId === moduleId && b.line === line);
  const next: ScriptBreakpoint = { ...(existing ?? { id: freshId(), moduleId, line, enabled: true }), ...patch };
  if (!next.condition) delete next.condition;
  if (!next.logMessage) delete next.logMessage;
  return existing ? list.map(b => (b === existing ? next : b)) : [...list, next];
}

/**
 * The script's breakpoints moved with an edit (the gutter tracks them as decorations): `lines` maps each
 * of its breakpoint ids to its line now. Two that landed on one line (a deletion between them) merge.
 */
export function relocate(list: readonly ScriptBreakpoint[], moduleId: string, lines: ReadonlyMap<string, number>): ScriptBreakpoint[] {
  let changed = false;
  const taken = new Set<number>();
  const out: ScriptBreakpoint[] = [];
  for (const b of list) {
    if (b.moduleId !== moduleId) { out.push(b); continue; }
    const line = lines.get(b.id) ?? b.line;
    if (taken.has(line)) { changed = true; continue; }
    taken.add(line);
    if (line !== b.line) { changed = true; out.push({ ...b, line }); } else out.push(b);
  }
  return changed ? out : (list as ScriptBreakpoint[]);
}

/** A script was renamed or moved: its breakpoints follow its new module id. */
export function renameModule(list: readonly ScriptBreakpoint[], from: string, to: string): ScriptBreakpoint[] {
  return list.some(b => b.moduleId === from) ? list.map(b => (b.moduleId === from ? { ...b, moduleId: to } : b)) : (list as ScriptBreakpoint[]);
}

function isBreakpoint(value: any): value is ScriptBreakpoint {
  return !!value && typeof value.id === 'string' && typeof value.moduleId === 'string'
    && Number.isInteger(value.line) && value.line > 0 && typeof value.enabled === 'boolean';
}

/** A stored list, tolerating anything a hand edit or an older build left. */
export function parseBreakpoints(raw: string | null): ScriptBreakpoint[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isBreakpoint).map(b => ({
      id: b.id, moduleId: b.moduleId, line: b.line, enabled: b.enabled,
      ...(typeof b.condition === 'string' && b.condition ? { condition: b.condition } : {}),
      ...(typeof b.logMessage === 'string' && b.logMessage ? { logMessage: b.logMessage } : {}),
    })) : [];
  } catch {
    return [];
  }
}

// ---- The store -------------------------------------------------------------------------------------

let list: ScriptBreakpoint[] | null = null;
const listeners = new Set<() => void>();

function storageKey(): string | null {
  try { return lsKey(LS_KEYS.scriptBreakpoints); } catch { return null; }
}

function load(): ScriptBreakpoint[] {
  if (list) return list;
  const key = storageKey();
  try { list = parseBreakpoints(key ? localStorage.getItem(key) : null); } catch { list = []; }
  return list;
}

export function getBreakpoints(): readonly ScriptBreakpoint[] { return load(); }

export function setBreakpoints(next: ScriptBreakpoint[]): void {
  if (next === list) return;
  list = next;
  const key = storageKey();
  try {
    if (key) { if (next.length) localStorage.setItem(key, JSON.stringify(next)); else localStorage.removeItem(key); }
  } catch { /* no storage: they last until reload */ }
  for (const listener of listeners) listener();
}

export function updateBreakpoints(fn: (current: readonly ScriptBreakpoint[]) => ScriptBreakpoint[]): void {
  setBreakpoints(fn(load()));
}

export function subscribeBreakpoints(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useBreakpoints(): readonly ScriptBreakpoint[] {
  return useSyncExternalStore(subscribeBreakpoints, getBreakpoints, getBreakpoints);
}

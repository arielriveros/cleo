import { Logger } from 'cleo';
import type { SceneChange } from 'cleo';

/**
 * Debug channel for unsaved-changes (dirty) tracking.
 *
 * Since the event-system overhaul every edit marks the active tab unsaved, driven by the engine's
 * per-setter SCENE_CHANGED events. That breadth is the point, but it makes a *false positive* — a tab
 * going dirty when the user did nothing — hard to attribute, because the mark can come from any of ~16
 * call sites or any engine setter. This logs what dirtied a tab, and (verbosely) which guard rejected a
 * mark, so either can be pinned to a specific change kind, node or code path.
 *
 * Everything goes to the editor Console panel under the `Dirty` scope, which ConsolePanel renders with
 * its own colour chip and a per-scope checkbox filter — so the channel is hideable from the UI without
 * touching this flag.
 *
 * Toggle at runtime from devtools, no rebuild needed:
 *   cleoDirtyDebug.off()          // silence
 *   cleoDirtyDebug.verbose(true)  // also report rejected marks
 *   cleoDirtyDebug.status()
 */

const KEY_ON = 'cleo_debug_dirty';
const KEY_VERBOSE = 'cleo_debug_dirty_verbose';

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback; // private mode / storage disabled
  }
}

function persist(key: string, value: boolean): void {
  try { localStorage.setItem(key, value ? '1' : '0'); } catch { /* ignore */ }
}

// Cached in module state rather than re-read from localStorage per call: logDirtySkip runs on EVERY
// change event — which during a camera orbit is every frame — and a storage read there would cost real
// time for a channel that is usually off.
let enabled = readFlag(KEY_ON, true);
let verbose = readFlag(KEY_VERBOSE, false);

/** Running totals per rejection key, so a repeated skip updates one row instead of appending. */
const skipCounts = new Map<string, number>();

/** Human-readable cause from the payload the dirty bridge already receives. */
export function describeChange(e?: SceneChange): string {
  if (!e) return 'direct';
  const node = e.node ? ` on "${e.node.name}" #${e.node.id.slice(0, 6)}` : '';
  const prop = e.prop ? ` prop=${e.prop}` : '';
  return `${e.kind}${node}${prop}`;
}

/** A tab just went clean -> dirty. `reason` is the change description or a call-site label. */
export function logDirtyMark(tabLabel: string, reason: string): void {
  if (!enabled) return;
  Logger.info(`dirty  ${tabLabel}  <- ${reason}`, 'Dirty');
}

/** A tab was saved / reset. Logged too so the panel reads as a timeline and a false positive right
 *  after a save stands out. */
export function logDirtyClear(tabLabel: string): void {
  if (!enabled) return;
  Logger.info(`clean  ${tabLabel}`, 'Dirty');
}

/**
 * A mark was rejected by one of the guards. Verbose-only.
 *
 * Takes the raw {@link SceneChange} rather than a formatted string so nothing is built when verbose is
 * off — this is the hot path. Uses Logger's *named flush*, which rewrites that row wherever it already
 * sits, so an orbiting camera keeps a single self-updating `x143` row instead of thousands of rows; a
 * flushed row also skips the native console entirely, so it cannot flood devtools either.
 */
export function logDirtySkip(reason: string, e?: SceneChange): void {
  if (!enabled || !verbose) return;
  const key = e?.node ? `${reason}:${e.node.name}` : reason;
  const n = (skipCounts.get(key) ?? 0) + 1;
  skipCounts.set(key, n);
  const what = e?.node ? ` "${e.node.name}"` : '';
  const kind = e?.kind ? ` (${e.kind})` : '';
  Logger.info(`skip   ${reason}${what}${kind} x${n}`, 'Dirty', { flush: `dirty-skip:${key}` });
}

export const dirtyDebug = {
  on() { enabled = true; persist(KEY_ON, true); Logger.info('dirty logging ON', 'Dirty'); },
  // Logged before disabling, so the confirmation itself still reaches the panel.
  off() { Logger.info('dirty logging OFF', 'Dirty'); enabled = false; persist(KEY_ON, false); },
  verbose(on: boolean = true) {
    verbose = on;
    persist(KEY_VERBOSE, on);
    skipCounts.clear();
    Logger.info(`dirty verbose ${on ? 'ON' : 'OFF'}`, 'Dirty');
  },
  status() { return { enabled, verbose }; },
  /** Forget the per-reason skip tallies (starts the x-counts over). */
  reset() { skipCounts.clear(); },
};

// Reachable from the browser console without a rebuild.
if (typeof window !== 'undefined') (window as any).cleoDirtyDebug = dirtyDebug;

// "Show this script at that line" — asked by the Console's links to a script error and by the script
// debugger when the game stops; answered by the Script tab's Monaco editor.
//
// Two halves, both module-level so neither caller needs to sit inside the engine context:
// - the OPENER (registered by EngineContext) opens the script's tab, or hands the file to VSCode when the
//   user opens scripts there;
// - the pending REVEAL is what the tab's editor applies once it is mounted. The tab mounts after it
//   commits, lazily, so the line cannot be applied by whoever asked; MonacoScriptEditor takes it on mount,
//   or right away when the tab was already open.

export interface ScriptReveal {
  scriptId: string;
  /** 1-based. */
  line: number;
  /** Bumped per request, so asking for the same line twice reveals it twice. */
  seq: number;
}

let pending: ScriptReveal | null = null;
let seq = 0;
const listeners = new Set<() => void>();

export function subscribeScriptReveal(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getScriptRevealSeq(): number { return seq; }

/** Ask the script's editor (open now or later) to show `line`. */
export function requestScriptReveal(scriptId: string, line: number): void {
  pending = { scriptId, line: Math.max(1, Math.floor(line)), seq: ++seq };
  for (const listener of listeners) listener();
}

/** The pending reveal for this script, consumed — each request is applied once. */
export function takeScriptReveal(scriptId: string): ScriptReveal | null {
  if (!pending || pending.scriptId !== scriptId) return null;
  const reveal = pending;
  pending = null;
  return reveal;
}

/** `inEditor`: always the built-in editor, whatever the "open scripts with VSCode" preference says. */
type LineOpener = (scriptId: string, line: number, inEditor: boolean) => void;

let opener: LineOpener | null = null;

/** Registered by EngineContext for as long as it is mounted. */
export function setScriptLineOpener(fn: LineOpener | null): void { opener = fn; }

/**
 * Open a script at a line: its Script tab with the line revealed, or the user's external editor at that
 * line when they open scripts there (unless `inEditor`, which the debugger asks for — its markers live in
 * the built-in editor). False when nothing can open scripts (no engine context mounted).
 */
export function openScriptAt(scriptId: string, line: number, options: { inEditor?: boolean } = {}): boolean {
  if (!opener) return false;
  opener(scriptId, line, !!options.inEditor);
  return true;
}

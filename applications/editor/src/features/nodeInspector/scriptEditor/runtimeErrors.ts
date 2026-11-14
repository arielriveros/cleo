// The lines where scripts failed while the game ran, for the script editor to mark (a red squiggle across
// the line, the error as its hover).
//
// Fed from the engine's log bus: a script error is logged with its location (`source`, from the engine's
// logScriptError), whether the game runs in the editor or in its own window (whose rows the play-window
// controller re-emits here). Kept until the next Play starts: the marks are about the last run.
import { CleoEngine, Logger, moduleIdOfScriptUrl, type LogEntry } from 'cleo';

export interface RuntimeError {
  /** 1-based. */
  line: number;
  message: string;
  /** How many times it was logged — an error in onUpdate repeats every frame. */
  count: number;
}

const byModule = new Map<string, Map<number, RuntimeError>>();
const listeners = new Set<() => void>();
let revision = 0;
let attached = false;

function changed(): void {
  revision++;
  for (const listener of listeners) listener();
}

function messageOf(entry: LogEntry): string {
  const first = entry.data?.[0];
  if (typeof first === 'string') return first;
  if (first instanceof Error) return `${first.name}: ${first.message}`;
  return String(first ?? 'Error');
}

function ingest(entry: LogEntry): void {
  if (entry.method !== 'error' || !entry.source) return;
  const moduleId = moduleIdOfScriptUrl(entry.source.url);
  if (!moduleId) return;
  let lines = byModule.get(moduleId);
  if (!lines) byModule.set(moduleId, lines = new Map());
  const existing = lines.get(entry.source.line);
  const message = messageOf(entry);
  if (existing && existing.message === message) existing.count++;
  else lines.set(entry.source.line, { line: entry.source.line, message, count: 1 });
  changed();
}

function attach(): void {
  if (attached) return;
  attached = true;
  // Attached on first use (a script tab opening, a Play starting), so take what the engine's ring buffer
  // already holds: an error logged before any script tab was open is still marked when one opens.
  for (const entry of Logger.logs) ingest(entry);
  CleoEngine.eventEmitter.on('LOG', ingest);
  CleoEngine.eventEmitter.on('LOG_UPDATE', ingest);
}

export function subscribeRuntimeErrors(listener: () => void): () => void {
  attach();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getRuntimeErrorsRevision(): number { return revision; }

/** The failed lines of one script (by module id), in line order. */
export function runtimeErrorsFor(moduleId: string | undefined): RuntimeError[] {
  const lines = moduleId ? byModule.get(moduleId) : undefined;
  return lines ? [...lines.values()].sort((a, b) => a.line - b.line) : [];
}

/** A new run starts: the last one's marks go. */
export function clearRuntimeErrors(): void {
  attach();
  if (!byModule.size) return;
  byModule.clear();
  changed();
}

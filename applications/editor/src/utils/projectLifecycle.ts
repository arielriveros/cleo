// The open project's writes and its lifetime, for switching projects inside the running editor.
//
// Opening another project used to reload the page, and the reload was the reset: whatever a writer had pending
// died with the page. Switching in place (features/projects/projectSwitch.ts) has to do that by hand, in an
// order that keeps one project's data out of the other's keys:
//   1. flush: the debounced writes still waiting run now, while the old project is still the open one;
//   2. unmount: every provider's own cleanup runs (their timers go);
//   3. drain: the writes already under way finish, every key they compute still naming the old project;
//   4. only then the active project changes (utils/projects.ts activateProject), and the next one mounts.
// A writer that reads the open project when it fires (scoped keys, `activeProjectId()`) is safe so long as it
// is either scheduled here (flushed, or cancelled by its unmount) or tracked (drained).
//
// Also the hooks the switch runs around that: what a mounted provider stops before it goes (Play), and what a
// module holding per-project state forgets once the project is gone.

/** Debounced writes waiting to run, each able to run now. */
const pending = new Set<{ run: () => void }>();
/** Writes under way. */
const inflight = new Set<Promise<unknown>>();
const unloadHooks = new Set<() => unknown>();
const closeHooks = new Set<() => unknown>();

/** Count a write under way, so a switch waits for it before another project opens. Returns `p`. */
export function trackProjectWrite<T>(p: Promise<T>): Promise<T> {
  inflight.add(p);
  const done = () => { inflight.delete(p); };
  p.then(done, done);
  return p;
}

/**
 * A debounced write for the open project: `run` after `ms`, tracked while it runs. Returns the cancel to call
 * from an effect's cleanup. A switch to another project runs it at once instead of losing it (flushProjectWrites).
 */
export function scheduleProjectWrite(ms: number, run: () => unknown): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const entry = {
    run: () => {
      if (!pending.delete(entry)) return;
      clearTimeout(timer);
      try {
        const result = run();
        if (result && typeof (result as Promise<unknown>).then === 'function') trackProjectWrite(result as Promise<unknown>).catch(() => {});
      } catch { /* the writer reports its own failures */ }
    },
  };
  pending.add(entry);
  timer = setTimeout(entry.run, ms);
  return () => { pending.delete(entry); clearTimeout(timer); };
}

/** Run every debounced write still waiting, now. */
export function flushProjectWrites(): void {
  for (const entry of [...pending]) entry.run();
}

/** Drop every debounced write still waiting (the project they would write is being deleted). */
export function cancelProjectWrites(): void {
  pending.clear();
}

/** Writes waiting or under way: for tests and the switch's log. */
export function pendingProjectWrites(): { waiting: number; running: number } {
  return { waiting: pending.size, running: inflight.size };
}

/**
 * Wait for every write under way, and for any those start, to settle. Resolves `{ timedOut: true }` when some
 * are still running after `timeoutMs`: the caller decides whether that is safe to go on from.
 */
export async function drainProjectWrites(timeoutMs = 15_000): Promise<{ timedOut: boolean }> {
  const deadline = Date.now() + timeoutMs;
  while (inflight.size > 0) {
    const left = deadline - Date.now();
    if (left <= 0) return { timedOut: true };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), left); });
    const settled = await Promise.race([Promise.allSettled([...inflight]).then(() => 'settled' as const), timeout]);
    clearTimeout(timer);
    if (settled === 'timeout' && inflight.size > 0) return { timedOut: true };
  }
  return { timedOut: false };
}

/** Something to stop before the open project's providers unmount (a Play session). Returns the unregister. */
export function onProjectUnload(hook: () => unknown): () => void {
  unloadHooks.add(hook);
  return () => { unloadHooks.delete(hook); };
}

/** Run every unload hook, in order, each awaited; one that throws is logged and the rest still run. */
export async function runProjectUnloadHooks(): Promise<void> {
  for (const hook of [...unloadHooks]) {
    try { await hook(); } catch (e) { console.warn('[projects] an unload hook failed', e); }
  }
}

/**
 * Per-project state held at module level, to forget once the project is closed (its providers unmounted, its
 * writes drained). Registered once, at module scope, by the module holding it. Returns the unregister.
 */
export function onProjectClose(hook: () => unknown): () => void {
  closeHooks.add(hook);
  return () => { closeHooks.delete(hook); };
}

/** Run every close hook; one that throws is logged and the rest still run. */
export async function resetProjectState(): Promise<void> {
  for (const hook of [...closeHooks]) {
    try { await hook(); } catch (e) { console.warn('[projects] resetting project state failed', e); }
  }
}

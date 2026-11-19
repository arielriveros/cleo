import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  scheduleProjectWrite, flushProjectWrites, cancelProjectWrites, trackProjectWrite, drainProjectWrites,
  pendingProjectWrites, onProjectUnload, runProjectUnloadHooks, onProjectClose, resetProjectState,
} from '../src/utils/projectLifecycle';
import { activeProjectId, scoped, setActiveProjectId } from '../src/utils/projectScope';

// A project switch in the running editor (features/projects/projectSwitch.ts) must keep one project's data out
// of the other's keys. A write that reads the open project when it RUNS (a scoped key) is safe when it runs
// before the open project changes: flushed while it still waits, or drained while it is under way.

beforeEach(() => { cancelProjectWrites(); setActiveProjectId('A'); });

describe('a project\'s writes across a switch', () => {
  it('runs a debounced write on its own timer, once', async () => {
    vi.useFakeTimers();
    try {
      let runs = 0;
      scheduleProjectWrite(400, () => { runs++; });
      vi.advanceTimersByTime(399);
      expect(runs).toBe(0);
      vi.advanceTimersByTime(1);
      expect(runs).toBe(1);
      flushProjectWrites();
      expect(runs).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  it('flushed before the open project changes, a waiting write lands in the project it was made in', () => {
    const keys: string[] = [];
    scheduleProjectWrite(60_000, () => { keys.push(scoped('cleo_materials')); });
    // The switch: flush, then (after the unmount and the drain) another project opens.
    flushProjectWrites();
    setActiveProjectId('B');
    expect(keys).toEqual(['p:A:cleo_materials']);
    expect(pendingProjectWrites().waiting).toBe(0);
  });

  it('a write the effect cleaned up (or the switch dropped) never runs', async () => {
    vi.useFakeTimers();
    try {
      let runs = 0;
      const cancel = scheduleProjectWrite(100, () => { runs++; });
      cancel();
      scheduleProjectWrite(100, () => { runs++; });
      cancelProjectWrites(); // deleting the project: nothing of it is written
      flushProjectWrites();
      vi.advanceTimersByTime(1000);
      expect(runs).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('drains the writes under way, and the ones they start, before the open project may change', async () => {
    const order: string[] = [];
    let release!: () => void;
    const first = new Promise<void>(r => { release = r; });
    trackProjectWrite(first.then(() => {
      order.push(`first ${activeProjectId()}`);
      // A write that starts another as it ends (a library save, then its meta).
      trackProjectWrite(Promise.resolve().then(() => { order.push(`second ${activeProjectId()}`); }));
    }));
    // A flushed write's promise is tracked too.
    scheduleProjectWrite(60_000, () => Promise.resolve().then(() => { order.push(`flushed ${activeProjectId()}`); }));
    flushProjectWrites();
    const drained = drainProjectWrites(5000);
    release();
    expect(await drained).toEqual({ timedOut: false });
    setActiveProjectId('B');
    expect(order.sort()).toEqual(['first A', 'flushed A', 'second A']);
    expect(pendingProjectWrites().running).toBe(0);
  });

  it('reports a write that does not finish in time', async () => {
    trackProjectWrite(new Promise(() => {}));
    expect(await drainProjectWrites(20)).toEqual({ timedOut: true });
  });

  it('runs the unload hooks before the unmount, and the close hooks after, each once registered', async () => {
    const calls: string[] = [];
    const offUnload = onProjectUnload(async () => { calls.push('stop play'); });
    const offClose = onProjectClose(() => { calls.push('forget'); });
    // One that throws does not stop the rest.
    const offBad = onProjectClose(() => { throw new Error('boom'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runProjectUnloadHooks();
    await resetProjectState();
    offUnload(); offClose(); offBad();
    await runProjectUnloadHooks();
    await resetProjectState();
    warn.mockRestore();
    expect(calls).toEqual(['stop play', 'forget']);
  });
});

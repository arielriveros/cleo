import { describe, it, expect, beforeEach, vi } from 'vitest';

// Opening another project in the running editor (features/projects/projectSwitch.ts): no page reload, and an
// order that keeps one project's data out of another's keys. Everything the switch drives is faked here, and
// each fake writes what it did to `log`, so the order is what is checked.

const log: string[] = [];
let projects: { id: string; name: string; updatedAt: number }[] = [];
let active = 'A';
let confirmAnswer = true;
let unsaved: string[] = [];

vi.mock('cleo', () => ({ Logger: { info: () => {}, warn: () => {}, error: (m: string) => log.push(`error ${m}`) } }));
vi.mock('../src/utils/projects', () => ({
  loadProjects: async () => projects,
  foldersOnly: () => false,
  createProject: async (name: string) => { const p = { id: `new-${name}`, name, updatedAt: 0 }; projects.push(p); log.push(`create ${name}`); return p; },
  activateProject: async (id: string) => { active = id; log.push(`activate ${id}`); },
  nextProjectAfterDelete: async (id: string) => [...projects].filter(p => p.id !== id).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null,
  parkPendingDelete: (id: string) => log.push(`park ${id}`),
  clearPendingDelete: (id: string) => log.push(`unpark ${id}`),
  wipeProject: async (id: string) => { projects = projects.filter(p => p.id !== id); log.push(`wipe ${id}`); },
}));
vi.mock('../src/utils/projectScope', () => ({ activeProjectId: () => active }));
vi.mock('../src/features/unloadGuard', () => ({
  confirmDiscard: async (action: string) => { log.push(`confirm ${action}`); return confirmAnswer; },
  reloadDiscarding: () => log.push('RELOAD'),
  setUnsavedWork: (labels: string[]) => { unsaved = labels; },
}));
vi.mock('../src/features/loading/bootLoad', () => ({ beginSwitchLoad: (title: string) => log.push(`load ${title}`) }));
vi.mock('../src/features/editorEngine', () => ({ resetEngineProjectState: async () => { log.push('reset engine'); } }));
vi.mock('../src/features/playWindow/windowPlay', () => ({ stopWindowPlay: () => log.push('stop window play') }));
vi.mock('@cleo/app-kit/code/projectTypes', () => ({ setProjectTypes: () => {} }));

const lifecycle = await import('../src/utils/projectLifecycle');
const { switchProject, openProject, reopenProject, deleteProject, registerProjectHost, isSwitchingProject } = await import('../src/features/projects/projectSwitch');

/** A host whose unmount waits for a write the closing project still had under way. */
let unregister: (() => void) | null = null;
function host(options: { failMount?: boolean } = {}) {
  unregister?.();
  unregister = registerProjectHost({
    unmount: async () => { log.push('unmount'); },
    mount: () => { log.push(`mount ${active}`); if (options.failMount) throw new Error('mount failed'); },
    showLauncher: async () => { log.push('launcher'); },
    showFailure: (m: string) => { log.push(`failure ${m}`); },
  });
}

beforeEach(() => {
  log.length = 0;
  projects = [{ id: 'A', name: 'Alpha', updatedAt: 2 }, { id: 'B', name: 'Beta', updatedAt: 1 }];
  active = 'A';
  confirmAnswer = true;
  unsaved = ['Main scene'];
  lifecycle.cancelProjectWrites();
  host();
});

describe('opening another project in place', () => {
  it('closes the open one, then opens the next, in that order, and never reloads the page', async () => {
    lifecycle.onProjectUnload(() => { log.push('stop play'); });
    lifecycle.onProjectClose(() => { log.push('forget modules'); });
    // A library edit still waiting on its debounce, and a save under way when the switch begins.
    lifecycle.scheduleProjectWrite(60_000, () => { log.push(`write ${active}`); });
    let finishSave!: () => void;
    lifecycle.trackProjectWrite(new Promise<void>(r => { finishSave = r; }).then(() => { log.push(`save done ${active}`); }));
    setTimeout(() => finishSave(), 10);

    expect(await openProject('B')).toBe(true);
    const at = (entry: string) => log.indexOf(entry);
    expect(log).not.toContain('RELOAD');
    expect(at('confirm Opening another project')).toBe(0);
    expect(at('stop play')).toBeGreaterThan(at('confirm Opening another project'));
    // The waiting write lands in A, before the unmount; the save under way finishes before the switch goes on.
    expect(at('write A')).toBeGreaterThan(at('stop play'));
    expect(at('unmount')).toBeGreaterThan(at('write A'));
    expect(at('save done A')).toBeGreaterThan(-1);
    expect(at('reset engine')).toBeGreaterThan(at('save done A'));
    expect(at('forget modules')).toBeGreaterThan(at('reset engine'));
    expect(at('activate B')).toBeGreaterThan(at('forget modules'));
    expect(at('load Opening Beta')).toBeGreaterThan(at('activate B'));
    expect(at('mount B')).toBeGreaterThan(at('load Opening Beta'));
    // The closed project's unsaved-work list goes with it.
    expect(unsaved).toEqual([]);
  });

  it('does nothing at all when the user keeps their unsaved edits', async () => {
    confirmAnswer = false;
    expect(await openProject('B')).toBe(false);
    expect(log).toEqual(['confirm Opening another project']);
    expect(active).toBe('A');
  });

  it('refuses a second switch while one is under way', async () => {
    let release!: () => void;
    lifecycle.trackProjectWrite(new Promise<void>(r => { release = r; }));
    const first = openProject('B');
    await vi.waitFor(() => expect(isSwitchingProject()).toBe(true));
    expect(await switchProject({ to: 'A', confirm: null })).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(active).toBe('B');
  });

  it('writes an import into the open project with nothing of it running, then opens it again', async () => {
    expect(await reopenProject({ prepare: async () => { log.push(`import into ${active}`); } })).toBe(true);
    const at = (entry: string) => log.indexOf(entry);
    expect(at('import into A')).toBeGreaterThan(at('unmount'));
    expect(at('activate A')).toBeGreaterThan(at('import into A'));
    expect(at('mount A')).toBeGreaterThan(at('activate A'));
  });

  it('opens the project again when an import fails after it closed', async () => {
    await reopenProject({ prepare: async () => { throw new Error('bad bundle'); } });
    expect(log.some(l => l.startsWith('error Could not open'))).toBe(true);
    expect(log.slice(-2)).toEqual(['load Opening Alpha', 'mount A']);
  });

  it('shows the failure screen when the next project cannot mount', async () => {
    host({ failMount: true });
    await openProject('B');
    expect(log.some(l => l.startsWith('failure Opening Beta failed'))).toBe(true);
  });
});

describe('deleting the open project', () => {
  it('closes it, wipes it, then opens the most recent of the rest; its waiting writes are dropped, not flushed', async () => {
    lifecycle.scheduleProjectWrite(60_000, () => { log.push(`write ${active}`); });
    await deleteProject('A', true);
    const at = (entry: string) => log.indexOf(entry);
    expect(log).not.toContain('write A');
    expect(log).not.toContain('RELOAD');
    // Parked before anything closes, so a crash midway still wipes it at the next boot; unparked once wiped.
    expect(at('park A')).toBeLessThan(at('unmount'));
    expect(at('wipe A')).toBeGreaterThan(at('reset engine'));
    expect(at('unpark A')).toBeGreaterThan(at('wipe A'));
    expect(at('activate B')).toBeGreaterThan(at('unpark A'));
    expect(at('mount B')).toBeGreaterThan(at('activate B'));
    expect(projects.map(p => p.id)).toEqual(['B']);
  });

  it('keeps it parked when a write of it was still running, for the next boot to sweep', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    try {
      lifecycle.trackProjectWrite(new Promise<void>(r => { release = r; }));
      const done = deleteProject('A', true);
      // The drain gives up after 15 s.
      await vi.advanceTimersByTimeAsync(15_100);
      await done;
      expect(log).toContain('wipe A');
      expect(log).not.toContain('unpark A');
      expect(log).toContain('mount B');
    } finally {
      release();
      vi.useRealTimers();
    }
  });

  it('starts a new empty project when it was the last, created only after the delete went ahead', async () => {
    projects = [{ id: 'A', name: 'Alpha', updatedAt: 2 }];
    await deleteProject('A', true);
    const at = (entry: string) => log.indexOf(entry);
    expect(at('create Untitled Project')).toBeGreaterThan(at('unmount'));
    expect(log).toContain('mount new-Untitled Project');
  });

  it('wipes a project that is not open at once, opening nothing', async () => {
    await deleteProject('B', false);
    expect(log).toEqual(['wipe B']);
  });
});

describe('the one place the open project changes', () => {
  it('is activateProject: nothing else sets the active project', async () => {
    const { readFileSync, readdirSync, statSync } = await import('fs');
    const path = await import('path');
    const src = path.join(__dirname, '..', 'src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const file = path.join(dir, name);
        if (statSync(file).isDirectory()) { walk(file); continue; }
        if (!/\.(ts|tsx)$/.test(name)) continue;
        const rel = path.relative(src, file).split(path.sep).join('/');
        if (rel === 'utils/projectScope.ts' || rel === 'utils/projects.ts') continue;
        if (/\bsetActiveProjectId\s*\(/.test(readFileSync(file, 'utf8'))) offenders.push(rel);
      }
    };
    walk(src);
    expect(offenders, 'open another project through features/projects/projectSwitch.ts').toEqual([]);
  });
});

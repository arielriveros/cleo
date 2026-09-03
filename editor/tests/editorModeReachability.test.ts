import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Two ways an editor mode can be built, wired into the dock, given a panel — and still be impossible to
 * reach. Both shipped at once, and neither showed up as an error anywhere: the mode simply did nothing.
 *
 * 1. THE MODE SELECTOR. `setEditorMode` only commits values that are `MainMode`; everything else is
 *    silently dropped, because most modes belong to a tab rather than to the scene tab's sub-mode. The
 *    Input mode's button called `select('input')` while `MainMode` had never gained `'input'`, so
 *    clicking it was a no-op.
 *
 * 2. THE TAB -> MODE MAP. `editorMode` for a library tab comes from `TAB_EDITOR_MODE`. That used to be a
 *    `?:` chain ending in `: 'template'`, so the sound tab — which nobody added a branch for — opened as
 *    a TEMPLATE tab: the wrong panels, the wrong chrome, and no clue why. The map is now an exhaustive
 *    `Record<Exclude<TabKind, 'scene'>, EditorMode>`, so the compiler catches a missing kind; this test
 *    additionally pins that no entry points at some OTHER kind's mode, which types cannot see.
 *
 * Both checks read source rather than importing: `EngineContext` pulls in the whole engine.
 */

const SRC = join(__dirname, '..', 'src');
// core.autocrlf checks this tree out with CRLF on Windows; every pattern below is written against \n.
const read = (...parts: string[]) => readFileSync(join(SRC, ...parts), 'utf-8').replace(/\r\n/g, '\n');

const TAB_STATE = read('utils', 'tabState.ts');
const MODE_SELECTOR = read('features', 'ModeSelector.tsx');
const CONTEXT_TYPES = read('features', 'engineContextTypes.ts');

/** The modes `setEditorMode` will actually commit. */
function mainModes(): string[] {
  const m = TAB_STATE.match(/export const MAIN_MODES: readonly MainMode\[\] = \[([^\]]*)\]/);
  expect(m, 'MAIN_MODES not found in utils/tabState.ts').toBeTruthy();
  return [...m![1].matchAll(/'([^']+)'/g)].map(x => x[1]);
}

/** Every mode the selector's buttons ask for. */
function selectedModes(): string[] {
  return [...MODE_SELECTOR.matchAll(/select\('([^']+)'\)/g)].map(m => m[1]);
}

function tabEditorModeEntries(): [string, string][] {
  const m = CONTEXT_TYPES.match(/export const TAB_EDITOR_MODE:[^=]*= \{([\s\S]*?)\n\};/);
  expect(m, 'TAB_EDITOR_MODE not found in features/engineContextTypes.ts').toBeTruthy();
  return [...m![1].matchAll(/^\s*(\w+): '([^']+)',/gm)].map(x => [x[1], x[2]] as [string, string]);
}

describe('every editor mode the UI offers is reachable', () => {
  it('the mode selector only asks for modes setEditorMode accepts', () => {
    const accepted = new Set(mainModes());
    const asked = selectedModes();
    expect(asked.length).toBeGreaterThan(0);
    const unreachable = asked.filter(mode => !accepted.has(mode));
    expect(unreachable, `ModeSelector offers ${unreachable.join(', ')}, which MAIN_MODES does not include — the button would do nothing`).toEqual([]);
  });

  it('input is one of them — the mode this test was written for', () => {
    expect(mainModes()).toContain('input');
    expect(selectedModes()).toContain('input');
  });
});

describe('TAB_EDITOR_MODE', () => {
  it('maps every tab kind but the scene tab', () => {
    const kinds = CONTEXT_TYPES.match(/export type TabKind = ([^;]+);/);
    expect(kinds).toBeTruthy();
    const all = [...kinds![1].matchAll(/'([^']+)'/g)].map(m => m[1]).filter(k => k !== 'scene');
    const mapped = tabEditorModeEntries().map(([kind]) => kind);
    expect(mapped.sort()).toEqual(all.sort());
  });

  // The failure the old `?:` chain produced: a tab kind resolving to a DIFFERENT kind's mode. Every tab
  // kind happens to share its name with its mode, so anything else is a copy-paste slip.
  it('never points a tab kind at another kind\'s mode', () => {
    for (const [kind, mode] of tabEditorModeEntries()) expect(mode).toBe(kind);
  });

  it('gives the sound tab its own mode, not the template fallback', () => {
    expect(Object.fromEntries(tabEditorModeEntries()).soundSample).toBe('soundSample');
  });
});

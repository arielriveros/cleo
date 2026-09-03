import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A regression guard, in the source-scanning style of hookOrder.test.ts.
//
// window.alert / confirm / prompt block the renderer, stall the WebGL loop, and wear OS chrome that the
// editor's dark theme cannot touch — which is why every one of them became a dialogStore call or a toast.
// The failure mode this pins is quiet: a reintroduced confirm() still works in a browser tab, so it
// passes review and only misbehaves in the packaged desktop build, with nothing in the console to say so.
//
// Deliberately a regex over source text rather than a parse: the rule is about a name never appearing,
// which does not need a type checker, and a cheap check that runs on every commit is the point.

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(item.name)) out.push(full);
  }
  return out;
}

// `window.confirm(...)`, and a bare `alert(...)` / `confirm(...)` that is not a property access
// (so `api.confirm(...)` or `dialog.prompt(...)` are left alone).
const QUALIFIED = /\bwindow\s*\.\s*(alert|confirm|prompt)\s*\(/;
const BARE = /(^|[^.\w$])(alert|confirm|prompt)\s*\(/;


// One line with its comments removed, or '' when the whole line is one. A block-comment CONTINUATION
// (`* text`) has to go too: these files explain in prose exactly what they no longer call, and a doc
// line reading "`location.reload()` on a page with unsaved edits" is not a call site.
function codeOf(line: string): string {
  const trimmed = line.trim();
  if (trimmed.startsWith('*') || trimmed.startsWith('//')) return '';
  return line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
}

describe('no native browser dialogs in the editor', () => {
  it('finds source files to scan', () => {
    expect(sourceFiles(SRC).length).toBeGreaterThan(100);
  });

  it('has no window.alert / confirm / prompt call anywhere in src/', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        // Comments name these three constantly — every replacement explains what it replaced.
        const code = codeOf(line);
        if (QUALIFIED.test(code) || BARE.test(code)) {
          const rel = path.relative(SRC, file).split(path.sep).join('/');
          offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
        }
      });
    }

    expect(
      offenders,
      'Use confirmDialog/alertDialog/promptDialog from features/dialogs/dialogStore, or toast from ' +
      'features/toasts/toastStore. Native dialogs do not belong in the desktop build.',
    ).toEqual([]);
  });

  // `beforeunload` is the FOURTH native dialog, and the one the check above cannot see: a handler that
  // sets `returnValue` BLOCKS the unload, and whoever is hosting the page then asks about it — Chrome
  // with its "Leave site?" box, the Electron shell with nothing at all, the window simply refusing to
  // close. It cannot be deleted (it is the only thing that can stop a browser tab closing), so the rule
  // is that it stays the LAST resort: the desktop shell hands the blocked attempt back to the editor
  // (features/desktopShell.ts), and every navigation the editor starts itself asks first
  // (features/unloadGuard.ts) and stands the handler down.
  //
  // A `beforeunload` listener that shows nothing — DockLayout flushes the dock arrangement in one — is
  // fine and deliberately not matched here. What is pinned is the blocking kind.
  it('blocks the unload in exactly one place, and lets the editor stand it down', () => {
    const blocking: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const source = readFileSync(file, 'utf8');
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      source.split('\n').forEach((line, i) => {
        const code = codeOf(line);
        if (/\breturnValue\s*=/.test(code)) blocking.push(`${rel}:${i + 1}`);
      });
    }

    expect(
      blocking.length,
      `beforeunload blocks from ${blocking.join(', ') || 'nowhere'}. There must be exactly one, in ` +
      'EngineContext.',
    ).toBe(1);
    expect(blocking[0].startsWith('features/EngineContext.tsx')).toBe(true);

    // ...and it must yield to a navigation the editor itself is performing, or the app's own dialog and
    // the browser's box both appear, one on top of the other.
    const context = readFileSync(path.join(SRC, 'features', 'EngineContext.tsx'), 'utf8');
    const effect = context.slice(
      context.indexOf('const hasUnsavedWork ='),
      context.indexOf('returnValue'),
    );
    expect(
      effect,
      'the beforeunload handler must return early on unloadGuardSuppressed()',
    ).toMatch(/unloadGuardSuppressed\(\)/);
  });

  // The rule that keeps the browser's box off the navigations the editor STARTS. `location.reload()` on
  // a page holding unsaved edits is what raises it — so the editor asks first, in its own dialog, and
  // reloads through the guard. Every such reload therefore goes through unloadGuard.ts, and a bare one
  // anywhere else is the box coming back.
  it('never reloads the page outside the unload guard', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      if (rel === 'features/unloadGuard.ts') continue;
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const code = codeOf(line);
        if (/\blocation\s*\.\s*(reload\s*\(|href\s*=|assign\s*\(|replace\s*\()/.test(code))
          offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(
      offenders,
      'Use discardAndReload/reloadDiscarding from features/unloadGuard, or switchToProject from ' +
      'utils/projects. A bare reload leaves the browser to ask about unsaved work in its own words.',
    ).toEqual([]);
  });
});

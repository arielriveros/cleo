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
        const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
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
});

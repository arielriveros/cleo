import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';

/**
 * The desktop shell's unload guard, pinned at its seams.
 *
 * `beforeunload` can stop a close or a reload but not ask about it — the host does that. A browser puts
 * up Chromium's "Leave site?" box; Electron puts up nothing and the window silently refuses to close.
 * `will-prevent-unload` is where a shell gets to answer for itself: main.js bounces the attempt into the
 * editor, which asks with `confirmDialog` like every other question, and then carries it out or drops it.
 *
 * Three files have to agree on two channel names, across two process boundaries and a
 * `contextBridge`. Nothing throws when they stop agreeing: `ipcRenderer.send` to a channel nobody
 * listens on is a no-op, `ipcMain.on` for a channel nobody sends is never called, and the guard simply
 * stops guarding — the window closes on dirty work with no dialog and no error. `editor/tests/
 * noNativeDialogs.test.ts` holds the other half: that `beforeunload` blocks in exactly one place and stands down for a navigation the editor started.
 */

const ROOT = join(__dirname, '..');
const MAIN = readFileSync(join(ROOT, 'desktop', 'main.js'), 'utf-8');
const PRELOAD = readFileSync(join(ROOT, 'desktop', 'preload.js'), 'utf-8');
const BRIDGE = readFileSync(join(ROOT, 'editor', 'src', 'features', 'desktopShell.ts'), 'utf-8');

/** main -> renderer, then renderer -> main. */
const CHANNELS = ['shell:confirm-unload', 'shell:unload-response'];

describe('desktop unload guard', () => {
  it('uses the same channel names in the main process and the preload bridge', () => {
    for (const channel of CHANNELS) {
      expect(MAIN, `desktop/main.js never mentions ${channel}`).toContain(channel);
      expect(PRELOAD, `desktop/preload.js never mentions ${channel}`).toContain(channel);
    }
  });

  it('listens in main for what the preload sends, and vice versa', () => {
    // The renderer sends the answer; main must be listening for it.
    expect(PRELOAD).toMatch(/ipcRenderer\.send\('shell:unload-response'/);
    expect(MAIN).toMatch(/ipcMain\.on\('shell:unload-response'/);
    // ...and main asks the question, which the preload must be listening for.
    expect(MAIN).toMatch(/webContents\.send\('shell:confirm-unload'/);
    expect(PRELOAD).toMatch(/ipcRenderer\.on\('shell:confirm-unload'/);
  });

  it('exposes the bridge under the name the editor reads it from', () => {
    // desktopShell.ts reaches `window.cleoDesktop.shell`, so the preload must nest it there.
    expect(BRIDGE).toContain('cleoDesktop?.shell');
    expect(PRELOAD).toMatch(/exposeInMainWorld\('cleoDesktop'/);
    expect(PRELOAD).toMatch(/\bshell:\s*\{/);
    for (const method of ['onConfirmUnload', 'respondToUnload']) {
      expect(PRELOAD, `preload's shell bridge has no ${method}`).toMatch(new RegExp(`\\b${method}\\s*:`));
      expect(BRIDGE, `desktopShell.ts does not require ${method}`).toContain(method);
    }
  });

  it('hangs the question off will-prevent-unload, which covers a reload as well as a close', () => {
    // A close-only guard leaves Ctrl+R discarding unsaved work in silence. This event fires for both.
    expect(MAIN).toMatch(/webContents\.on\('will-prevent-unload'/);
    expect(MAIN).toContain("action === 'close'");
    expect(MAIN).toMatch(/webContents\.reload\(\)/);
  });

  it('proceeds anyway if the renderer never answers', () => {
    // Without this the guard is a trap: a hung or crashed renderer keeps cancelling the close and the
    // only way out is the task manager.
    expect(MAIN).toMatch(/setTimeout\(/);
    expect(MAIN).toContain('UNLOAD_ANSWER_TIMEOUT_MS');
  });

  it('parses — neither desktop file is loadable outside Electron, so nothing else would catch a typo', () => {
    for (const file of ['main.js', 'preload.js']) {
      expect(() => execFileSync(process.execPath, ['--check', join(ROOT, 'desktop', file)]))
        .not.toThrow();
    }
  });
});

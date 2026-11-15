import { describe, it, expect, vi } from 'vitest';
import {
  getVsCodeDebugStatus, onVsCodeEvent, onVsCodeResumed, stoppedInVsCode, waitForVsCode, forgetVsCodeSession,
} from '../src/features/scriptDebugger/vscodeAttach';
import { launchConfiguration, launchJson, staticScaffold, DEFAULT_DEBUG_PORT } from '../src/features/scriptWorkspace/scaffold';
import { parseEditorPrefs, DEFAULT_VSCODE_DEBUG_PORT } from '../src/features/options/editorPrefs';

// Debugging from VS Code: what the editor keeps of the desktop app's debug port (vscodeAttach.ts), and the
// launch configuration the script workspace gets (scaffold.ts). The port itself is tests/desktopDebugPort.test.ts.

const S = 'aaaabbbbccccdddd';

describe('VS Code attached to the debug port', () => {
  it('follows the port\'s status, and which game VS Code holds stopped', () => {
    onVsCodeEvent({ type: 'vscode-status', listening: true, port: 9339, clients: 1 });
    expect(getVsCodeDebugStatus()).toMatchObject({ listening: true, port: 9339, clients: 1 });
    const resumed: string[] = [];
    onVsCodeResumed(id => resumed.push(id));
    onVsCodeEvent({ type: 'vscode-paused', sessionId: S });
    expect(stoppedInVsCode(S)).toBe(true);
    onVsCodeEvent({ type: 'vscode-resumed', sessionId: S });
    expect(stoppedInVsCode(S)).toBe(false);
    // Play in window asks the game for its state again.
    expect(resumed).toEqual([S]);
    onVsCodeEvent({ type: 'vscode-paused', sessionId: S });
    forgetVsCodeSession(S);
    expect(stoppedInVsCode(S)).toBe(false);
    onVsCodeResumed(null);
  });

  it('lets a first boot wait for VS Code\'s breakpoints when it is connected, and only then', async () => {
    vi.useFakeTimers();
    try {
      onVsCodeEvent({ type: 'vscode-status', listening: true, port: 9339, clients: 0 });
      let done = false;
      void waitForVsCode('1111222233334444').then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(true); // nobody attached: no wait at all

      onVsCodeEvent({ type: 'vscode-status', listening: true, port: 9339, clients: 1 });
      let ready = false;
      void waitForVsCode('5555666677778888').then(() => { ready = true; });
      await vi.advanceTimersByTimeAsync(100);
      expect(ready).toBe(false);
      onVsCodeEvent({ type: 'vscode-ready', sessionId: '5555666677778888' });
      await vi.advanceTimersByTimeAsync(0);
      expect(ready).toBe(true);
      // Already set up: at once.
      let again = false;
      void waitForVsCode('5555666677778888').then(() => { again = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(again).toBe(true);

      // Connected but never finishing: the cap.
      let capped = false;
      void waitForVsCode('9999aaaabbbbcccc', 3000).then(() => { capped = true; });
      await vi.advanceTimersByTimeAsync(2900);
      expect(capped).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(capped).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the workspace\'s launch configuration', () => {
  it('attaches VS Code\'s Chrome debugger to the game windows on the debug port, mapping script URLs to the folder', () => {
    const c = launchConfiguration(9444);
    expect(c).toMatchObject({
      type: 'chrome', request: 'attach', port: 9444, urlFilter: '*play.html*',
      pathMapping: { 'cleo-script:///': '${workspaceFolder}/' },
      // The running code is the TypeScript with its types stripped: it never matches the file byte for byte.
      enableContentValidation: false,
    });
    expect(c.skipFiles).toContain('app://**');
    expect(launchConfiguration().port).toBe(DEFAULT_DEBUG_PORT);
    expect(DEFAULT_DEBUG_PORT).toBe(DEFAULT_VSCODE_DEBUG_PORT);
  });

  it('is a launch.json VS Code reads (JSON with comments), written only where the workspace has none', () => {
    const text = launchJson(9339);
    const json = JSON.parse(text.split('\n').filter(l => !l.trim().startsWith('//')).join('\n'));
    expect(json.version).toBe('0.2.0');
    expect(json.configurations[0].name).toBe('Attach to the Cleo game');
    const file = staticScaffold(9339).find(f => f.rel === '.vscode/launch.json');
    expect(file).toMatchObject({ keep: true });
    // The rest of the scaffold is rewritten on every connect, as before.
    expect(staticScaffold().filter(f => f.keep).map(f => f.rel)).toEqual(['.vscode/launch.json']);
  });
});

describe('the debugger preferences', () => {
  it('debug with Cleo unless VS Code was chosen, on a sane port', () => {
    expect(parseEditorPrefs({})).toMatchObject({ scriptDebugWith: 'cleo', vscodeDebugPort: 9339 });
    expect(parseEditorPrefs({ scriptDebugWith: 'vscode', vscodeDebugPort: 9555 })).toMatchObject({ scriptDebugWith: 'vscode', vscodeDebugPort: 9555 });
    expect(parseEditorPrefs({ scriptDebugWith: 'gdb', vscodeDebugPort: 80 })).toMatchObject({ scriptDebugWith: 'cleo', vscodeDebugPort: 9339 });
    expect(parseEditorPrefs({ vscodeDebugPort: 9339.5 }).vscodeDebugPort).toBe(9339);
  });
});

// The script debugger's half in the main process: a DevTools-protocol session on the game window
// (playWindow.js), driven by the editor (applications/editor/src/features/scriptDebugger/).
//
// The game runs in a renderer of its own, so a script stopped at a breakpoint stops only the game; the
// editor stays live and shows where it stopped. The editor cannot reach another renderer's debugger
// itself — the main process can, through `webContents.debugger` — so this relays:
//
//   editor --play:debug (one allowlisted command)--> here --sendCommand--> game window
//   game window --message (events)--> here --play:event {type:'debug'}--> editor
//
// Only what the debugger uses passes, both ways: the commands below, and the Debugger events about USER
// scripts (cleo-script:/// and cleo-inline:///, scriptUrls.ts). A page in dev parses hundreds of modules;
// their scriptParsed events stop here.
//
// Measured on Electron 31 (the spike behind this file):
//   - attaching BEFORE the window's first navigation commits loses every command but Debugger.enable
//     (they go to the about:blank renderer the navigation replaces), so attach() runs on `did-navigate`;
//   - by-URL breakpoints survive a reload of the page (Restart), in the same session;
//   - opening DevTools on the window does NOT detach this session;
//   - Overlay.setPausedInDebuggerMessage needs no Overlay.enable.

/** Commands the editor may send. Everything else is refused before it reaches the page. */
const ALLOWED = new Set([
  'Debugger.enable',
  'Debugger.setBreakpointByUrl',
  'Debugger.removeBreakpoint',
  'Debugger.setBreakpointsActive',
  'Debugger.setPauseOnExceptions',
  'Debugger.setSkipAllPauses',
  'Debugger.setBlackboxPatterns',
  'Debugger.resume',
  'Debugger.pause',
  'Debugger.stepOver',
  'Debugger.stepInto',
  'Debugger.stepOut',
  'Debugger.evaluateOnCallFrame',
  'Debugger.getScriptSource',
  'Runtime.getProperties',
  'Runtime.evaluate',
  'Runtime.releaseObjectGroup',
  'Overlay.setPausedInDebuggerMessage',
]);

/**
 * Engine and app code is "ignored" (blackboxed): stepping never enters it, Pause lands on the next script
 * line, and an exception thrown and caught inside it never stops the game.
 */
const IGNORE_PATTERNS = ['^(?!cleo-(script|inline):)'];

const SCRIPT_URL = /^cleo-(script|inline):\/\//;

function isScriptUrl(url) {
  return typeof url === 'string' && SCRIPT_URL.test(url);
}

/**
 * What of a protocol event goes on to the editor: null to drop it. A script's parse events are trimmed to
 * what maps a location back to its file. Pure, for the tests.
 */
function forwardEvent(method, params) {
  switch (method) {
    case 'Debugger.scriptParsed':
    case 'Debugger.scriptFailedToParse': {
      if (!params || !isScriptUrl(params.url)) return null;
      const { scriptId, url, hash, startLine, endLine } = params;
      return { method, params: { scriptId, url, hash, startLine, endLine } };
    }
    case 'Debugger.paused':
    case 'Debugger.resumed':
    case 'Debugger.breakpointResolved':
      return { method, params: params || {} };
    default:
      return null;
  }
}

/** The pause-on-exceptions state for the editor's toggle. */
function exceptionState(pauseOnExceptions) {
  // 'all', not 'uncaught': every script handler runs inside the engine's try/catch, so to V8 a script's
  // error is always caught. With engine code ignored, 'all' stops where a script throws (or where engine
  // code a script called throws) and never for the engine's own caught exceptions.
  return pauseOnExceptions ? 'all' : 'none';
}

/**
 * Attach to a game window and set the session up: Debugger on, engine code ignored, exceptions per the
 * editor's toggle. `emit(payload)` gets every forwarded event as `{ type: 'debug', method, params }`, then
 * `{ type: 'debug-attached' }` once the setup is in, or `{ type: 'debug-detached', reason }`.
 */
function attachDebugger(contents, emit, options = {}) {
  const dbg = contents.debugger;
  let attached = false;

  const onMessage = (_event, method, params) => {
    const out = forwardEvent(method, params);
    if (out) emit({ type: 'debug', method: out.method, params: out.params });
  };
  const onDetach = (_event, reason) => {
    attached = false;
    dbg.removeListener('message', onMessage);
    dbg.removeListener('detach', onDetach);
    emit({ type: 'debug-detached', reason: String(reason || 'detached') });
  };

  try {
    if (!dbg.isAttached()) dbg.attach('1.3');
  } catch (e) {
    emit({ type: 'debug-detached', reason: `could not attach: ${e && e.message ? e.message : e}` });
    return null;
  }
  attached = true;
  dbg.on('message', onMessage);
  dbg.on('detach', onDetach);

  const session = {
    get attached() { return attached && !contents.isDestroyed() && dbg.isAttached(); },
    send(method, params) {
      if (!ALLOWED.has(method)) return Promise.reject(new Error(`Not a debugger command: ${method}`));
      if (!session.attached) return Promise.reject(new Error('The debugger is not attached'));
      return dbg.sendCommand(method, params || {});
    },
    /** Detaching also resumes a page stopped at a breakpoint, so a closing window never hangs on it. */
    detach() {
      if (!attached) return;
      attached = false;
      dbg.removeListener('message', onMessage);
      dbg.removeListener('detach', onDetach);
      try { if (!contents.isDestroyed() && dbg.isAttached()) dbg.detach(); } catch { /* already gone */ }
    },
  };

  Promise.all([
    dbg.sendCommand('Debugger.enable', {}),
    dbg.sendCommand('Debugger.setBlackboxPatterns', { patterns: IGNORE_PATTERNS, skipAnonymous: true }),
    dbg.sendCommand('Debugger.setPauseOnExceptions', { state: exceptionState(!!options.pauseOnExceptions) }),
  ]).then(
    () => { if (attached) emit({ type: 'debug-attached' }); },
    (e) => emit({ type: 'debug-detached', reason: `setup failed: ${e && e.message ? e.message : e}` }),
  );
  return session;
}

module.exports = { ALLOWED, IGNORE_PATTERNS, isScriptUrl, forwardEvent, exceptionState, attachDebugger };

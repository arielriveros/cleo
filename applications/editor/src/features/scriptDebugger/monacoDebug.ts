// The script debugger inside a Script tab's Monaco editor: breakpoints in the glyph margin (click to
// toggle, right-click for the rest), the line the game is stopped on, and the values under the mouse while
// it is stopped. Attached by MonacoScriptEditor for as long as the tab is open.

import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { getBreakpoints, relocate, subscribeBreakpoints, toggleAt, updateBreakpoints, type ScriptBreakpoint } from './breakpoints';
import { canDebugScripts, scriptDebugger } from './debugSession';
import { getEditorPrefs } from '../options/editorPrefs';
import { toast } from '@cleo/app-kit/feedback/toastStore';
import type { BreakpointState, DebugSnapshot } from './debugController';
import { describeRemote } from './cdp';

export interface ScriptDebugging { dispose(): void }

export interface ScriptDebuggingOptions {
  /** The open script's module id, read when needed (a rename changes it while the tab is open). */
  moduleId(): string | undefined;
  /** Right-click in the breakpoint margin: the tab shows its menu for that line. */
  onGutterMenu(line: number, at: { x: number; y: number }): void;
  /** The script's text changed: the debugger re-checks what the running game is out of date with. */
  onTextChanged(): void;
}

const MOUSE_GLYPH = 2; // monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN
const NEVER_GROWS = 1; // monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges

function glyphClass(b: ScriptBreakpoint, state: BreakpointState | undefined): string {
  const kind = b.logMessage ? 'cleo-bp cleo-bp-log' : b.condition ? 'cleo-bp cleo-bp-cond' : 'cleo-bp';
  const off = !b.enabled || state === 'disabled' || state === 'inactive' || state === 'stale';
  return off ? `${kind} cleo-bp-off` : kind;
}

function glyphHover(b: ScriptBreakpoint, state: BreakpointState | undefined): string {
  const what = b.logMessage ? `Logpoint: ${b.logMessage}` : b.condition ? `Breakpoint when: ${b.condition}` : 'Breakpoint';
  const why = !b.enabled ? ' (disabled)'
    : state === 'inactive' ? ' (breakpoints are off)'
    : state === 'stale' ? ' — this script changed since the game was built: save and Restart to use it'
    : state === 'pending' ? ' (not on a line that has run yet)'
    : '';
  return `${what}${why}. Click to remove; right-click for more.`;
}

export function attachScriptDebugging(
  editor: Monaco.editor.IStandaloneCodeEditor,
  monaco: typeof Monaco,
  options: ScriptDebuggingOptions,
): ScriptDebugging {
  editor.updateOptions({ glyphMargin: true });
  const debug = scriptDebugger();
  const breakpointDecorations = editor.createDecorationsCollection();
  const stopDecorations = editor.createDecorationsCollection();
  const hintDecorations = editor.createDecorationsCollection();
  /** The breakpoints in `breakpointDecorations`, in the same order. */
  let shown: ScriptBreakpoint[] = [];
  let hintLine = 0;

  const mine = (): ScriptBreakpoint[] => {
    const id = options.moduleId();
    return id ? getBreakpoints().filter(b => b.moduleId === id) : [];
  };

  function renderBreakpoints(): void {
    const model = editor.getModel();
    if (!model) return;
    const states = debug.getSnapshot().states;
    const lines = model.getLineCount();
    shown = mine().filter(b => b.line <= lines);
    breakpointDecorations.set(shown.map(b => ({
      range: new monaco.Range(b.line, 1, b.line, 1),
      options: {
        stickiness: NEVER_GROWS,
        glyphMarginClassName: glyphClass(b, states[b.id]),
        glyphMarginHoverMessage: { value: glyphHover(b, states[b.id]) },
      },
    })));
  }

  function renderStop(snapshot: DebugSnapshot): void {
    const id = options.moduleId();
    const pause = snapshot.paused;
    if (!pause || !id) { stopDecorations.clear(); return; }
    const selected = pause.frames[snapshot.selectedFrame];
    const decorations: Monaco.editor.IModelDeltaDecoration[] = [];
    pause.frames.forEach((frame, i) => {
      if (frame.moduleId !== id) return;
      const current = frame === selected;
      decorations.push({
        range: new monaco.Range(frame.line, 1, frame.line, 1),
        options: {
          isWholeLine: true,
          className: current ? 'cleo-debug-line' : 'cleo-debug-line-outer',
          ...(current || i === 0 ? { glyphMarginClassName: current ? 'cleo-debug-arrow' : 'cleo-debug-arrow-outer' } : {}),
          stickiness: NEVER_GROWS,
        },
      });
    });
    stopDecorations.set(decorations);
  }

  renderBreakpoints();
  renderStop(debug.getSnapshot());

  const offStore = subscribeBreakpoints(renderBreakpoints);
  let last = debug.getSnapshot();
  const offDebug = debug.subscribe(() => {
    const next = debug.getSnapshot();
    if (next.states !== last.states) renderBreakpoints();
    if (next.paused !== last.paused || next.selectedFrame !== last.selectedFrame) renderStop(next);
    last = next;
  });

  // Edits move the breakpoints with their lines (the decorations track them); write that back, a moment
  // after typing stops.
  let relocateTimer: ReturnType<typeof setTimeout> | null = null;
  const onContent = editor.onDidChangeModelContent(() => {
    if (relocateTimer) clearTimeout(relocateTimer);
    relocateTimer = setTimeout(() => {
      relocateTimer = null;
      const id = options.moduleId();
      if (id && shown.length) {
        const lines = new Map<string, number>();
        shown.forEach((b, i) => {
          const range = breakpointDecorations.getRange(i);
          if (range) lines.set(b.id, range.startLineNumber);
        });
        updateBreakpoints(list => relocate(list, id, lines));
      }
      options.onTextChanged();
    }, 250);
  });

  const onDown = editor.onMouseDown(e => {
    if (e.target.type !== MOUSE_GLYPH || !e.target.position || !e.event.leftButton) return;
    const id = options.moduleId();
    if (!id) return;
    const line = e.target.position.lineNumber;
    const adding = !getBreakpoints().some(b => b.moduleId === id && b.line === line);
    updateBreakpoints(list => toggleAt(list, id, line));
    if (adding) explainWhereBreakpointsWork();
  });
  // The menu opens on `contextmenu`, not on the right button's mousedown: on Windows the contextmenu
  // event comes after the button is released, and it would land on the menu's own outside-click catcher
  // and close it again at once. Monaco's own margin menu is kept from opening over ours.
  const onContext = editor.onContextMenu(e => {
    if (e.target.type !== MOUSE_GLYPH || !e.target.position) return;
    e.event.preventDefault();
    e.event.stopPropagation();
    if (options.moduleId()) options.onGutterMenu(e.target.position.lineNumber, { x: e.event.browserEvent.clientX, y: e.event.browserEvent.clientY });
  });

  // A faint dot where a click would put one.
  const onMove = editor.onMouseMove(e => {
    const line = e.target.type === MOUSE_GLYPH && e.target.position ? e.target.position.lineNumber : 0;
    if (line === hintLine) return;
    hintLine = line;
    hintDecorations.set(line && !shown.some(b => b.line === line)
      ? [{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: 'cleo-bp cleo-bp-hint' } }]
      : []);
  });
  const onLeave = editor.onMouseLeave(() => { hintLine = 0; hintDecorations.clear(); });

  ensureHoverProvider(monaco);

  return {
    dispose() {
      if (relocateTimer) clearTimeout(relocateTimer);
      offStore();
      offDebug();
      for (const d of [onContent, onDown, onContext, onMove, onLeave]) d.dispose();
      breakpointDecorations.clear();
      stopDecorations.clear();
      hintDecorations.clear();
    },
  };
}

let explained = false;

/**
 * The first breakpoint set where Cleo's debugger cannot use it says so, once a session: in the browser
 * (the game window's F12 is the debugger there), or with VS Code chosen as the debugger.
 */
function explainWhereBreakpointsWork(): void {
  if (explained) return;
  if (!canDebugScripts()) {
    explained = true;
    toast.info('Breakpoints stop the game in the Cleo desktop app. In the browser: Play in window, press F12 in the game window, and set breakpoints under Sources ▸ cleo-script://.');
  } else if (getEditorPrefs().scriptDebugWith === 'vscode') {
    explained = true;
    toast.info("Debugging with VS Code (Options ▸ Editor ▸ Scripts): set breakpoints in VS Code. These are for Cleo's own debugger.");
  }
}

// ---- Values under the mouse while the game is stopped -------------------------------------------------

const KEYWORDS = new Set([
  'abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'declare', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for',
  'from', 'function', 'get', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'new',
  'null', 'of', 'private', 'protected', 'public', 'readonly', 'return', 'set', 'static', 'super', 'switch',
  'throw', 'true', 'try', 'type', 'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield',
  'number', 'string', 'boolean', 'any', 'unknown', 'never', 'object',
]);

/**
 * The member chain ending at the word under the mouse: `this.target.position` when hovering `position`.
 * No calls and no indexing: hovering must never run the game's code. Null when there is nothing to show.
 */
export function hoverExpression(lineText: string, wordStart: number, wordEnd: number): string | null {
  const word = lineText.slice(wordStart, wordEnd);
  if (!/^[A-Za-z_$][\w$]*$/.test(word)) return null;
  let start = wordStart;
  // Walk left over `.ident` links.
  while (start > 1 && lineText[start - 1] === '.') {
    let j = start - 1;
    if (lineText[j - 1] === '?') j--; // optional chaining
    let k = j;
    while (k > 0 && /[\w$]/.test(lineText[k - 1])) k--;
    if (k === j) break;
    start = k;
  }
  const expr = lineText.slice(start, wordEnd);
  if (expr === word && KEYWORDS.has(word) && word !== 'this') return null;
  if (lineText[start - 1] === '.') return null;
  return expr;
}

let hoverRegistered = false;

/** The module id a script's Monaco model stands for (scriptModels.ts: file:///project/<id>.ts). */
function moduleIdOfModel(model: Monaco.editor.ITextModel): string | null {
  const path = model.uri.path;
  return path.startsWith('/project/') && path.endsWith('.ts') ? path.slice('/project'.length, -3) : null;
}

function ensureHoverProvider(monaco: typeof Monaco): void {
  if (hoverRegistered) return;
  hoverRegistered = true;
  monaco.languages.registerHoverProvider('typescript', {
    async provideHover(model, position) {
      const debug = scriptDebugger();
      const snapshot = debug.getSnapshot();
      const frame = snapshot.paused?.frames[snapshot.selectedFrame];
      if (!frame || !frame.moduleId || frame.moduleId !== moduleIdOfModel(model)) return null;
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const expression = hoverExpression(model.getLineContent(position.lineNumber), word.startColumn - 1, word.endColumn - 1);
      if (!expression) return null;
      try {
        const r = await debug.evaluate(expression, { hover: true });
        if (!r || r.exceptionDetails) return null;
        return {
          range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
          contents: [{ value: `\`${expression}\` = \`${describeRemote(r.result).replace(/`/g, "'")}\`` }],
        };
      } catch {
        return null;
      }
    },
  });
}

// Monaco themes for the script editor, matching codeMirrorTheme.ts's palette (same token names, same
// literal hex values in the light theme) so the two editors read as the same product while the flag in
// ScriptEditor.tsx decides which one is mounted.
//
// Monaco's two color surfaces need different formats: `colors` (editor chrome -- background, gutter,
// selection...) accepts any CSS color string, so the design-token rgb()/rgba() strings from token() work
// directly. `rules` (syntax token foreground) is parsed as a bare 6-digit hex with no '#' and no alpha,
// so CSS-var-backed colors go through hex() below instead of token().
//
// Never call defineCleoThemes before an editor mounts: like codeMirrorTheme.ts, it reads computed
// styles, and style-loader only injects index.css once the app's stylesheet import has run.
import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { token } from '../../../utils/cssTokens';

/** Same CSS custom property token() reads, as 6 hex digits (channels, no separators/prefix). */
function channelsHex(name: string): string {
  const channels = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!channels) return 'e5e7eb'; // same fallback as token(), hex form
  return channels
    .split(/\s+/)
    .map((c) => Math.max(0, Math.min(255, Number(c) || 0)).toString(16).padStart(2, '0'))
    .join('');
}

/** For `rules[].foreground` (Monaco's token colors): parsed as a bare 6-digit hex, no '#', no rgb(). */
function hex(name: string): string {
  return channelsHex(name);
}

/**
 * For the `colors` entries that ALSO seed the token theme's default foreground/background —
 * `editor.foreground`/`editor.background` specifically. Every other `colors` key genuinely accepts any
 * CSS color string (rgb()/rgba() included, so token() is fine there), but these two feed the same
 * hex-only parser `rules` does — token()'s rgb(...) format throws "Illegal value for token color" here.
 */
function hexColor(name: string): string {
  return `#${channelsHex(name)}`;
}

interface MonacoPalette {
  colors: Record<string, string>;
  keyword: string;
  string: string;
  number: string;
  comment: string;
  func: string;
  type: string;
  operator: string;
  variable: string;
}

function darkPalette(): MonacoPalette {
  return {
    colors: {
      'editor.background': hexColor('--surface-sunken'),
      'editor.foreground': hexColor('--text'),
      'editorLineNumber.foreground': token('--text-dim'),
      'editorLineNumber.activeForeground': token('--text'),
      'editor.selectionBackground': token('--primary', 0.35),
      'editor.lineHighlightBackground': token('--highlight', 0.06),
      'editorGutter.background': token('--bg'),
      'editorCursor.foreground': token('--highlight'),
      'editorBracketMatch.background': token('--highlight', 0.2),
      'editorBracketMatch.border': token('--highlight', 0.5),
      'editor.findMatchBackground': token('--primary', 0.5),
      'editor.findMatchHighlightBackground': token('--warning', 0.25),
      'editorWidget.background': token('--surface-raised'),
      'editorWidget.border': token('--border'),
      'editorHoverWidget.background': token('--surface-raised'),
      'editorHoverWidget.border': token('--border'),
      'editorSuggestWidget.background': token('--surface-raised'),
      'editorSuggestWidget.border': token('--border'),
      'editorSuggestWidget.selectedBackground': token('--primary'),
      'editorError.foreground': token('--danger'),
    },
    // Same hues as codeMirrorTheme.ts's darkPalette(): keyword/comment/cursor share --highlight/--text-dim
    // with the console inspector; string/number/type are the same seeded literals.
    keyword: hex('--highlight'),
    string: 'e3a869',
    number: '9980ff',
    comment: hex('--text-dim'),
    func: hex('--warning'),
    type: '4ec9b0',
    operator: hex('--text-muted'),
    variable: hex('--text'),
  };
}

function lightPalette(): MonacoPalette {
  return {
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#1f2430',
      'editorLineNumber.foreground': '#8a919c',
      'editorLineNumber.activeForeground': '#1f2430',
      'editor.selectionBackground': token('--primary', 0.2),
      'editor.lineHighlightBackground': '#f0f3f9',
      'editorGutter.background': '#f5f6f8',
      'editorCursor.foreground': token('--primary'),
      'editorBracketMatch.background': token('--primary', 0.18),
      'editorBracketMatch.border': token('--primary', 0.45),
      'editor.findMatchBackground': token('--primary', 0.35),
      'editor.findMatchHighlightBackground': '#ffe08a',
      'editorWidget.background': '#ffffff',
      'editorWidget.border': '#d4d8e0',
      'editorHoverWidget.background': '#ffffff',
      'editorHoverWidget.border': '#d4d8e0',
      'editorSuggestWidget.background': '#ffffff',
      'editorSuggestWidget.border': '#d4d8e0',
      'editorSuggestWidget.selectedBackground': token('--primary'),
      'editorError.foreground': token('--danger'),
    },
    keyword: '4b3bd6',
    string: 'a24a12',
    number: '5b21b6',
    comment: '6b7280',
    func: '8a6d00',
    type: '0f766e',
    operator: '6b7280',
    variable: '1f2430',
  };
}

function toThemeData(p: MonacoPalette, base: 'vs' | 'vs-dark'): Monaco.editor.IStandaloneThemeData {
  return {
    base,
    inherit: true,
    colors: p.colors,
    rules: [
      { token: 'comment', foreground: p.comment, fontStyle: 'italic' },
      { token: 'string', foreground: p.string },
      { token: 'number', foreground: p.number },
      { token: 'keyword', foreground: p.keyword },
      { token: 'identifier', foreground: p.variable },
      { token: 'type', foreground: p.type },
      { token: 'type.identifier', foreground: p.type },
      { token: 'delimiter', foreground: p.operator },
      { token: 'operator', foreground: p.operator },
      { token: 'function', foreground: p.func },
    ],
  };
}

let defined = false;

/** Registers 'cleo-dark'/'cleo-light' once. Safe to call again (no-ops after the first). */
export function defineCleoThemes(monaco: typeof Monaco): void {
  if (defined) return;
  defined = true;
  monaco.editor.defineTheme('cleo-dark', toThemeData(darkPalette(), 'vs-dark'));
  monaco.editor.defineTheme('cleo-light', toThemeData(lightPalette(), 'vs'));
}

// Monaco themes for the script editor, matching codeMirrorTheme.ts's palette. `rules` (syntax token
// foreground) is parsed as a bare 6-digit hex with no '#' and no alpha, so those go through hex() below
// rather than token(). Never call defineCleoThemes before an editor mounts: it reads computed styles.
import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api';

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
 * For `colors` entries: #rrggbb, or #rrggbbaa when alpha < 1. Monaco parses every themeData.colors value
 * with Color.fromHex, which accepts hex only and silently falls back to pure red (#ff0000) for anything
 * else — including token()'s `rgb(r g b)` strings. token() is for DOM widgets only.
 */
function colorHex(name: string, alpha = 1): string {
  const h = channelsHex(name);
  if (alpha >= 1) return `#${h}`;
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, '0');
  return `#${h}${a}`;
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
      'editor.background': colorHex('--surface-sunken'),
      'editor.foreground': colorHex('--text'),
      'editorLineNumber.foreground': colorHex('--text-dim'),
      'editorLineNumber.activeForeground': colorHex('--text'),
      'editor.selectionBackground': colorHex('--primary', 0.35),
      'editor.lineHighlightBackground': colorHex('--highlight', 0.06),
      'editorGutter.background': colorHex('--bg'),
      'editorCursor.foreground': colorHex('--highlight'),
      'editorBracketMatch.background': colorHex('--highlight', 0.2),
      'editorBracketMatch.border': colorHex('--highlight', 0.5),
      'editor.findMatchBackground': colorHex('--primary', 0.5),
      'editor.findMatchHighlightBackground': colorHex('--warning', 0.25),
      'editorWidget.background': colorHex('--surface-raised'),
      'editorWidget.border': colorHex('--border'),
      'editorHoverWidget.background': colorHex('--surface-raised'),
      'editorHoverWidget.border': colorHex('--border'),
      'editorSuggestWidget.background': colorHex('--surface-raised'),
      'editorSuggestWidget.border': colorHex('--border'),
      'editorSuggestWidget.selectedBackground': colorHex('--primary'),
      // A muted rose rather than the harsh --danger red. Hex, not rgb(): Monaco's parser accepts hex only.
      'editorError.foreground': '#e08a8a',
    },
    // Same hues as codeMirrorTheme.ts's darkPalette().
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
      'editor.selectionBackground': colorHex('--primary', 0.2),
      'editor.lineHighlightBackground': '#f0f3f9',
      'editorGutter.background': '#f5f6f8',
      'editorCursor.foreground': colorHex('--primary'),
      'editorBracketMatch.background': colorHex('--primary', 0.18),
      'editorBracketMatch.border': colorHex('--primary', 0.45),
      'editor.findMatchBackground': colorHex('--primary', 0.35),
      'editor.findMatchHighlightBackground': '#ffe08a',
      'editorWidget.background': '#ffffff',
      'editorWidget.border': '#d4d8e0',
      'editorHoverWidget.background': '#ffffff',
      'editorHoverWidget.border': '#d4d8e0',
      'editorSuggestWidget.background': '#ffffff',
      'editorSuggestWidget.border': '#d4d8e0',
      'editorSuggestWidget.selectedBackground': colorHex('--primary'),
      // Deeper muted rose than the dark theme's, for contrast on white.
      'editorError.foreground': '#c15858',
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

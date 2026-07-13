// CodeMirror themes for the editor's two code surfaces (the JS script editor and the GLSL material
// editor). Both used to render as a white box inside dark panels; these themes bridge CodeMirror to the
// design tokens in index.css, the same way dockview.css and consoleTheme.ts bridge their widgets.
//
// The dark theme reads its colors from the tokens, so it follows the editor if the tokens ever move. The
// light theme cannot: the app declares *only* a dark palette, so its surfaces, text and syntax colors are
// literals declared below. They are the dark hues rotated to white-background luminance, so the two
// themes still read as the same product.
//
// Appending our syntaxHighlighting() to basicSetup is enough to displace CodeMirror's built-in
// defaultHighlightStyle: basicSetup registers it with `{ fallback: true }`, and @codemirror/language only
// consults the fallback when no other highlighter is present.
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { token } from '../../../utils/cssTokens';

export type CodeThemeName = 'dark' | 'light';

export const CODE_THEMES: readonly CodeThemeName[] = ['dark', 'light'];

/** The palette a theme is built from. Dark fills this from tokens; light from the literals below. */
interface Palette {
  bg: string;
  gutterBg: string;
  gutterBorder: string;
  text: string;
  lineNumber: string;
  lineNumberActive: string;
  dim: string;
  muted: string;
  cursor: string;
  selection: string;
  activeLine: string;
  activeLineGutter: string;
  bracket: string;
  bracketOutline: string;
  searchMatch: string;
  searchMatchSelected: string;
  selectionMatch: string;
  // Chrome (tooltips, search panel).
  panelBg: string;
  panelBorder: string;
  control: string;
  controlHover: string;
  accent: string;
  accentText: string;
  danger: string;
  // Syntax.
  keyword: string;
  string: string;
  number: string;
  comment: string;
  func: string;
  type: string;
  operator: string;
  variable: string;
  invalid: string;
}

function darkPalette(): Palette {
  return {
    // The code well sits inside a `bg-surface-raised` Collapsable body, so a sunken surface reads right.
    bg: token('--surface-sunken'),
    gutterBg: token('--bg'),
    gutterBorder: token('--border-subtle'),
    text: token('--text'),
    lineNumber: token('--text-dim'),
    lineNumberActive: token('--text'),
    dim: token('--text-dim'),
    muted: token('--text-muted'),
    cursor: token('--highlight'),
    selection: token('--primary', 0.35), // matches index.css's global ::selection
    activeLine: token('--highlight', 0.06),
    activeLineGutter: token('--border-subtle', 0.6),
    bracket: token('--highlight', 0.2),
    bracketOutline: token('--highlight', 0.5),
    searchMatch: token('--warning', 0.25),
    searchMatchSelected: token('--primary', 0.5),
    selectionMatch: token('--highlight', 0.15),

    panelBg: token('--surface-raised'),
    panelBorder: token('--border'),
    control: token('--control'),
    controlHover: token('--control-hover'),
    accent: token('--primary'),
    accentText: '#ffffff',
    danger: token('--danger'),

    // Syntax hues are seeded from consoleTheme.ts's inspector palette so a value looks the same in the
    // console as the literal that produced it does in the code.
    keyword: token('--highlight'),
    string: '#e3a869',
    number: '#9980ff',
    comment: token('--text-dim'),
    func: token('--warning'),
    // The one invented color: no token supplies a teal legible on a dark surface, and GLSL leans hard on
    // type tokens (float, vec4, sampler2D), so they need to be distinct from keywords.
    type: '#4ec9b0',
    operator: token('--text-muted'),
    variable: token('--text'),
    invalid: token('--danger'),
  };
}

function lightPalette(): Palette {
  return {
    bg: '#ffffff',
    gutterBg: '#f5f6f8',
    gutterBorder: '#e4e6eb',
    text: '#1f2430',
    lineNumber: '#8a919c',
    lineNumberActive: '#1f2430',
    dim: '#6b7280',
    muted: '#6b7280',
    // The brand accents already read on white, so these stay on-token.
    cursor: token('--primary'),
    selection: token('--primary', 0.2),
    activeLine: '#f0f3f9',
    activeLineGutter: '#e8ecf5',
    bracket: token('--primary', 0.18),
    bracketOutline: token('--primary', 0.45),
    searchMatch: '#ffe08a',
    searchMatchSelected: token('--primary', 0.35),
    selectionMatch: '#e3e8f5',

    panelBg: '#ffffff',
    panelBorder: '#d4d8e0',
    control: '#f0f2f6',
    controlHover: '#e4e8ef',
    accent: token('--primary'),
    accentText: '#ffffff',
    danger: token('--danger'),

    // The dark hues, darkened until they carry on white.
    keyword: '#4b3bd6',
    string: '#a24a12',
    number: '#5b21b6',
    comment: '#6b7280',
    func: '#8a6d00',
    type: '#0f766e',
    operator: '#6b7280',
    variable: '#1f2430',
    invalid: token('--danger'),
  };
}

function buildTheme(p: Palette, dark: boolean): Extension {
  // `{ dark }` sets the EditorView.darkTheme facet, which drives CodeMirror's own base-theme variants
  // (tooltip shadows, panel defaults). It flips live through the compartment along with everything else.
  const view = EditorView.theme(
    {
      '&': {
        color: p.text,
        backgroundColor: p.bg,
        fontFamily: 'var(--font-mono)',
        fontSize: '12px',
        borderRadius: 'var(--radius)',
      },
      '.cm-content': {
        caretColor: p.cursor,
        padding: '4px 0',
      },
      '.cm-scroller': {
        fontFamily: 'var(--font-mono)',
        lineHeight: '1.5',
        overflow: 'auto',
        // index.css styles scrollbars globally for a dark app; the light theme has to reclaim them.
        scrollbarColor: `${p.control} ${p.gutterBg}`,
        scrollbarWidth: 'thin',
      },
      '.cm-scroller::-webkit-scrollbar': { width: '10px', height: '10px' },
      '.cm-scroller::-webkit-scrollbar-track': { background: p.gutterBg },
      '.cm-scroller::-webkit-scrollbar-thumb': {
        background: p.control,
        borderRadius: '6px',
        border: `2px solid ${p.gutterBg}`,
      },
      '.cm-scroller::-webkit-scrollbar-thumb:hover': { background: p.controlHover },

      '&.cm-focused .cm-cursor': { borderLeftColor: p.cursor, borderLeftWidth: '2px' },
      '.cm-dropCursor': { borderLeftColor: p.cursor },

      // All three are required: drawSelection paints .cm-selectionBackground, the unfocused variant needs
      // its own rule, and native ::selection still shows through in some states.
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: p.selection,
      },

      '.cm-gutters': {
        backgroundColor: p.gutterBg,
        color: p.lineNumber,
        border: 'none',
        borderRight: `1px solid ${p.gutterBorder}`,
      },
      '.cm-lineNumbers .cm-gutterElement': { minWidth: '28px', padding: '0 6px 0 8px' },
      '.cm-foldGutter .cm-gutterElement': { color: p.muted, padding: '0 2px' },
      '.cm-activeLine': { backgroundColor: p.activeLine },
      '.cm-activeLineGutter': { backgroundColor: p.activeLineGutter, color: p.lineNumberActive },

      '&.cm-focused .cm-matchingBracket': {
        backgroundColor: p.bracket,
        outline: `1px solid ${p.bracketOutline}`,
      },
      '&.cm-focused .cm-nonmatchingBracket': { color: p.danger },

      '.cm-searchMatch': { backgroundColor: p.searchMatch, outline: 'none' },
      '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: p.searchMatchSelected },
      '.cm-selectionMatch': { backgroundColor: p.selectionMatch },

      // Search / replace panel — mirrors the .input and .btn component classes from index.css.
      '.cm-panels': { backgroundColor: p.panelBg, color: p.text },
      '.cm-panels.cm-panels-top': { borderBottom: `1px solid ${p.panelBorder}` },
      '.cm-panels.cm-panels-bottom': { borderTop: `1px solid ${p.panelBorder}` },
      '.cm-panel.cm-search label': { color: p.muted, fontSize: '11px' },
      '.cm-textfield': {
        backgroundColor: p.control,
        color: p.text,
        border: `1px solid ${p.panelBorder}`,
        borderRadius: 'var(--radius)',
        padding: '2px 6px',
      },
      '.cm-button': {
        backgroundColor: p.control,
        // CodeMirror's base button paints a linear-gradient that would show through a flat color.
        backgroundImage: 'none',
        color: p.text,
        border: `1px solid ${p.panelBorder}`,
        borderRadius: 'var(--radius)',
        padding: '2px 8px',
      },
      '.cm-button:hover': { backgroundColor: p.controlHover },

      // Autocompletion popup.
      '.cm-tooltip': {
        backgroundColor: p.panelBg,
        color: p.text,
        border: `1px solid ${p.panelBorder}`,
        borderRadius: 'var(--radius)',
        boxShadow: '0 1px 1px rgba(0,0,0,0.15), 0 6px 12px rgba(0,0,0,0.25)',
      },
      '.cm-tooltip .cm-tooltip-arrow:before': { borderTopColor: p.panelBorder, borderBottomColor: p.panelBorder },
      '.cm-tooltip .cm-tooltip-arrow:after': { borderTopColor: p.panelBg, borderBottomColor: p.panelBg },
      '.cm-tooltip.cm-tooltip-autocomplete > ul': {
        fontFamily: 'var(--font-mono)',
        fontSize: '12px',
        maxHeight: '14em',
      },
      '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '2px 6px' },
      '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
        backgroundColor: p.accent,
        color: p.accentText,
      },
      '.cm-completionIcon': { color: p.muted, opacity: '0.8' },
      '.cm-completionLabel': { color: 'inherit' },
      '.cm-completionMatchedText': {
        color: dark ? p.keyword : p.accent,
        textDecoration: 'none',
        fontWeight: '600',
      },
      '.cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionMatchedText': {
        color: p.accentText,
        textDecoration: 'underline',
      },
      '.cm-completionDetail': { color: p.dim, fontStyle: 'italic' },
      '.cm-completionInfo': {
        backgroundColor: p.panelBg,
        border: `1px solid ${p.panelBorder}`,
        borderRadius: 'var(--radius)',
        padding: '4px 6px',
      },

      '.cm-placeholder': { color: p.dim },
      '.cm-specialChar': { color: p.danger },
      '.cm-foldPlaceholder': {
        backgroundColor: p.control,
        color: p.muted,
        border: `1px solid ${p.panelBorder}`,
        borderRadius: '3px',
        padding: '0 4px',
      },
    },
    { dark },
  );

  const highlight = HighlightStyle.define([
    { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.self, t.null], color: p.keyword },
    { tag: [t.string, t.special(t.string), t.character, t.escape, t.regexp], color: p.string },
    { tag: [t.number, t.bool, t.atom, t.constant(t.variableName), t.integer, t.float], color: p.number },
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: p.comment, fontStyle: 'italic' },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName, t.labelName], color: p.func },
    { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName), t.definition(t.typeName)], color: p.type },
    { tag: [t.operator, t.punctuation, t.separator, t.bracket, t.paren, t.squareBracket, t.brace, t.meta, t.processingInstruction], color: p.operator },
    { tag: [t.variableName, t.propertyName, t.attributeName, t.definition(t.variableName)], color: p.variable },
    { tag: t.link, color: p.keyword, textDecoration: 'underline' },
    { tag: t.strong, fontWeight: 'bold' },
    { tag: t.emphasis, fontStyle: 'italic' },
    // Color only — deliberately no squiggle and no background. The GLSL editor parses with the C grammar,
    // which recovers an error node on GLSL-only syntax (`in vec3 v;`), and that is not an error worth
    // shouting about. See glslLanguage.ts.
    { tag: t.invalid, color: p.invalid },
  ]);

  return [view, syntaxHighlighting(highlight)];
}

// Cached per name: it keeps the Extension identity stable across compartment reconfigures (so CodeMirror
// does not rebuild the StyleModules on every theme flip), and it defers the getComputedStyle reads until
// an editor actually mounts, by which point style-loader has injected index.css.
const cache = new Map<CodeThemeName, Extension>();

/** The `[EditorView.theme, syntaxHighlighting]` pair for a theme. Built on first use, then cached. */
export function getCodeTheme(name: CodeThemeName): Extension {
  const hit = cache.get(name);
  if (hit) return hit;

  const built = name === 'light' ? buildTheme(lightPalette(), false) : buildTheme(darkPalette(), true);
  cache.set(name, built);
  return built;
}

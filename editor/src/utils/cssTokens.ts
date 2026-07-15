// Runtime access to the design tokens declared in index.css. Anything that themes a third-party widget
// from JS (the console, the code editors) reads through here so the widgets can't drift from the rest of
// the editor.
//
// Never call this at module scope: style-loader injects index.css *after* module evaluation, so a read
// taken at import time sees an empty string. Read lazily, on first use, and cache the result yourself.

/** `--danger` holds space-separated RGB channels ("239 68 68"), so alpha comes for free.
 *
 * Produces a CSS `rgb()/rgb( / a)` string for DOM consumers (the console, CodeMirror). NOT usable for
 * Monaco theme colors: Monaco parses those with Color.fromHex and needs hex — see monacoTheme.ts's
 * colorHex(), which turns the same tokens into #rrggbb[aa]. */
export function token(name: string, alpha = 1): string {
  const channels = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!channels) return alpha === 1 ? '#e5e7eb' : 'transparent';
  return alpha === 1 ? `rgb(${channels})` : `rgb(${channels} / ${alpha})`;
}

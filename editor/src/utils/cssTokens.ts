// Runtime access to the design tokens declared in index.css, for anything theming a third-party widget
// from JS (the console, the code editors).
//
// Never call this at module scope: style-loader injects index.css AFTER module evaluation, so a read at
// import time sees an empty string. Read lazily, on first use, and cache the result yourself.

/** A CSS `rgb()` / `rgb( / a)` string for a token; the tokens hold space-separated RGB channels
 *  ("239 68 68"), so alpha comes for free.
 *
 *  NOT usable for Monaco theme colors — Monaco parses those with Color.fromHex and needs hex. Use
 *  monacoTheme.ts's colorHex() there. */
export function token(name: string, alpha = 1): string {
  const channels = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!channels) return alpha === 1 ? '#e5e7eb' : 'transparent';
  return alpha === 1 ? `rgb(${channels})` : `rgb(${channels} / ${alpha})`;
}

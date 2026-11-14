// Runtime access to the design tokens declared in index.css, for anything theming a third-party widget
// from JS (the console, the code editors, the Claude panel's terminal).
//
// Never call this at module scope: style-loader injects index.css AFTER module evaluation, so a read at
// import time sees an empty string. Read lazily, on first use, and cache the result yourself.
import { clamp } from './math';

/** A CSS `rgb()` / `rgb( / a)` string for a token; the tokens hold space-separated RGB channels
 *  ("239 68 68"), so alpha comes for free.
 *
 *  NOT usable where a widget parses hex only (Monaco's theme colours): use tokenHex() there. */
export function token(name: string, alpha = 1): string {
  const channels = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!channels) return alpha === 1 ? '#e5e7eb' : 'transparent';
  return alpha === 1 ? `rgb(${channels})` : `rgb(${channels} / ${alpha})`;
}

/** The same token as `#rrggbb`, or `#rrggbbaa` when alpha < 1. Monaco parses its theme colours with
 *  Color.fromHex, which turns anything else into pure red. */
export function tokenHex(name: string, alpha = 1): string {
  const channels = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const rgb = channels
    ? channels.split(/\s+/).map(c => clamp(Number(c) || 0, 0, 255).toString(16).padStart(2, '0')).join('')
    : 'e5e7eb'; // token()'s fallback
  if (alpha >= 1) return `#${rgb}`;
  return `#${rgb}${Math.round(clamp(alpha, 0, 1) * 255).toString(16).padStart(2, '0')}`;
}

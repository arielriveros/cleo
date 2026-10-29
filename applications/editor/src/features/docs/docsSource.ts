// The official docs as raw text, bundled at build time. Kept in a module of its own so docIndex can
// accept just THIS module on HMR: editing a page re-runs this file, and the open editor's tooltips
// re-read it without a reload.
//
// Only editor chrome imports this (via docIndex), so the published-game player never carries the docs.
export const DOC_FILES = import.meta.glob('../../../../../docs/**/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

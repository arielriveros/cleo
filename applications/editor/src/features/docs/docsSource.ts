import { registerDocSources } from '@cleo/app-kit/docs/docIndex';

// The official docs as raw text, bundled at build time and handed to the app-kit's doc index, which
// every tooltip reads. Kept in a module of its own and self-accepting on HMR: editing a page re-runs
// this file alone, and the open editor's tooltips re-read it without a reload.
//
// Only editor chrome imports this (index.tsx), so the published-game player never carries the docs.
export const DOC_FILES = import.meta.glob('../../../../../docs/**/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

registerDocSources(DOC_FILES);

if (import.meta.hot) import.meta.hot.accept();

import { registerDocSources } from '@cleo/app-kit/docs/docIndex';

// Cleo Creator's docs (docs/creator/*.md) for the tooltips, plus the editor's own pages the shared
// panels' titles resolve against. Self-accepting on HMR, so an edited page shows without a reload.
export const DOC_FILES = import.meta.glob(['../../../docs/creator/**/*.md', '../../../docs/editor/**/*.md'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

registerDocSources(DOC_FILES);

if (import.meta.hot) import.meta.hot.accept();

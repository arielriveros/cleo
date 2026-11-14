import { registerDocSources } from '@cleo/app-kit/docs/docIndex';

// Every docs page: Cleo Creator's own (docs/creator/*.md) for its tooltips, the editor's pages the shared
// panels' titles resolve against, and the rest for the docs viewer (Help > Documentation), whose pages
// link across folders. Tooltips only ever search the pages a DocScope names, so the extra pages change no
// card. Self-accepting on HMR, so an edited page shows without a reload.
export const DOC_FILES = import.meta.glob('../../../docs/**/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

registerDocSources(DOC_FILES);

if (import.meta.hot) import.meta.hot.accept();

import { useCallback } from 'react';
import { cn } from '../../ui/cn';
import { getDocSource } from '../docIndex';
import type { DocLink } from '../parseDocs';
import { openDocs } from './docsViewerStore';
import { MarkdownView } from './markdown';

/** One section of CHANGELOG.md (or of a release's notes): its heading and its markdown body. */
export interface ChangelogSection {
  /** `v1.1.2.4 — 2026-09-01`, `Unreleased`, or the release a set of notes belongs to. */
  title: string;
  markdown: string;
}

/**
 * Release notes, rendered like a docs page: Help ▸ About shows the running version's, the Update button the next
 * one's. Links to a bundled docs page open the docs window; anything on the web goes to the system browser.
 */
export function ChangelogView({ sections, className }: { sections: ChangelogSection[]; className?: string }) {
  const hasPage = useCallback((id: string) => getDocSource(id) !== undefined, []);
  const onLink = useCallback((link: DocLink) => {
    if (link.kind === 'external') { window.open(link.href, '_blank', 'noopener,noreferrer'); return; }
    if (link.kind === 'page') openDocs({ page: link.page, anchor: link.anchor });
  }, []);
  return (
    <div className={cn('flex flex-col gap-4 text-left [&_article]:text-ui', className)}>
      {sections.map((s, i) => (
        <section key={`${s.title}:${i}`}>
          <h3 className='text-ui font-semibold text-fg border-b border-border-subtle pb-1 mb-1'>{s.title}</h3>
          {s.markdown
            ? <MarkdownView page='changelog' source={s.markdown} hasPage={hasPage} onLink={onLink} />
            : <p className='text-ui-sm text-dim py-1'>No notes for this release.</p>}
        </section>
      ))}
    </div>
  );
}

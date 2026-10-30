import React from 'react';
import { cn } from './cn';
import { sectionTitleClass } from './typography';
import { DocHover } from './DocTooltip';
import { DocRegion, useDocEntry } from '../docs/DocScope';
import type { DocEntry } from '../docs/parseDocs';

/** Elevated bordered container (popovers, overlays, grouped chrome). */
export function Panel({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('rounded-md border border-border bg-surface-raised shadow-md', className)} {...rest}>
      {children}
    </div>
  );
}

export interface SectionTitleProps {
  title: React.ReactNode;
  /**
   * Where the docs describe this caption, when its text alone does not find it: a term, `page#anchor`
   * or `page[#anchor]::Term` (see resolveDocKey). `false` opts out.
   */
  doc?: string | false;
  className?: string;
  /** An entry the caller already resolved (Section does, to scope its body), skipping a second lookup. */
  entry?: DocEntry | null;
}

/**
 * The small uppercase caption of a group of controls, with the docs' hover card for it. Use this for
 * any sub-heading inside a panel, never a hand-styled div: the caption is what carries the explanation.
 */
export function SectionTitle({ title, doc, className, entry }: SectionTitleProps) {
  const own = useDocEntry(entry === undefined ? title : undefined, entry === undefined ? doc : false);
  return (
    <DocHover as='div' entry={entry === undefined ? own : entry} className={cn(sectionTitleClass, className)}>
      {title}
    </DocHover>
  );
}

export interface SectionProps {
  title?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** See SectionTitle. The caption's hover card comes from the docs; there is no hand-written hint. */
  doc?: string | false;
  /** Controls at the right end of the caption row (a Presets menu), outside the caption's styling. */
  right?: React.ReactNode;
}

/** A titled group of controls (uppercase caption + body). */
export function Section({ title, children, className, doc, right }: SectionProps) {
  const entry = useDocEntry(title, title === undefined ? false : doc);
  return (
    <div className={cn('mb-3', className)}>
      {title !== undefined && (right === undefined ? <SectionTitle title={title} entry={entry} className='mb-1' /> : (
        <div className='flex items-center justify-between gap-2 mb-1'>
          <SectionTitle title={title} entry={entry} />
          <div className='flex items-center gap-1 shrink-0'>{right}</div>
        </div>
      ))}
      <DocRegion entry={entry}>{children}</DocRegion>
    </div>
  );
}

export default Panel;

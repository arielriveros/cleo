import React from 'react';
import { cn } from './cn';
import { sectionTitleClass } from './typography';
import { hintAffordance } from './Field';

/** Elevated bordered container (popovers, overlays, grouped chrome). */
export function Panel({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('rounded-md border border-border bg-surface-raised shadow-md', className)} {...rest}>
      {children}
    </div>
  );
}

export interface SectionProps {
  title?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** Native tooltip on the caption, for explanation that would otherwise be a paragraph under it. */
  hint?: string;
  /** Controls at the right end of the caption row (a Presets menu), outside the caption's styling and hint. */
  right?: React.ReactNode;
}

/** A titled group of controls (uppercase caption + body). */
export function Section({ title, children, className, hint, right }: SectionProps) {
  const caption = (extra?: string) => (
    <div className={cn(sectionTitleClass, extra, hintAffordance(hint))} title={hint}>
      {title}
    </div>
  );
  return (
    <div className={cn('mb-3', className)}>
      {title !== undefined && (right === undefined ? caption('mb-1') : (
        <div className='flex items-center justify-between gap-2 mb-1'>
          {caption()}
          <div className='flex items-center gap-1 shrink-0'>{right}</div>
        </div>
      ))}
      {children}
    </div>
  );
}

export default Panel;

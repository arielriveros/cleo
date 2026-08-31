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
}

/** A titled group of controls (uppercase caption + body). */
export function Section({ title, children, className, hint }: SectionProps) {
  return (
    <div className={cn('mb-3', className)}>
      {title !== undefined && (
        <div
          className={cn(sectionTitleClass, 'mb-1', hintAffordance(hint))}
          title={hint}
        >
          {title}
        </div>
      )}
      {children}
    </div>
  );
}

export default Panel;

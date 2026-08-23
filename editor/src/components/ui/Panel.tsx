import React from 'react';
import { cn } from './cn';
import { sectionTitleClass } from './typography';

/** Elevated bordered container (popovers, overlays, grouped chrome). */
export function Panel({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('rounded-md border border-border bg-surface-raised shadow-md', className)} {...rest}>
      {children}
    </div>
  );
}

/** Small uppercase header bar for a Panel. */
export function PanelHeader({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('px-2 py-1 text-xs uppercase tracking-wide text-muted', className)} {...rest}>
      {children}
    </div>
  );
}

export interface SectionProps {
  title?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /**
   * Native tooltip on the caption, for the explanation that would otherwise be a paragraph under it.
   *
   * The renderer panels used to print a `Hint` beneath every group. That reads well once and then
   * costs vertical space forever, on panels that are already tall columns of controls — so the prose
   * moved here, where it is available on hover and free when it is not wanted.
   */
  hint?: string;
}

/** A titled group of controls (uppercase caption + body). Promoted from RendererOptions. */
export function Section({ title, children, className, hint }: SectionProps) {
  return (
    <div className={cn('mb-3', className)}>
      {title !== undefined && (
        <div
          className={cn(sectionTitleClass, 'mb-1', hint && 'cursor-help decoration-dotted underline underline-offset-2')}
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

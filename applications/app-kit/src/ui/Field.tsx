import React from 'react';
import { cn } from './cn';
import { hintClass, labelClass } from './typography';
import { DocHover } from './DocTooltip';
import { useDocEntry } from '../docs/DocScope';
import { reportShadowedHint } from '../docs/docIndex';

export { hintAffordance } from './typography';

export interface FieldProps {
  label?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  labelClassName?: string;
  /**
   * Native tooltip on the label, used only when the docs have no row for it: a label that names a row
   * of its section's docs (features/docs) shows that row's card instead.
   */
  hint?: string;
  /** Docs key for the label when its text is not the term (see resolveDocKey); `false` opts out. */
  doc?: string | false;
}

/** A labeled control row: fixed-width label on the left, control filling the rest. */
export function Field({ label, children, className, labelClassName, hint, doc }: FieldProps) {
  const entry = useDocEntry(label, doc, 'field');
  if (entry && hint) reportShadowedHint(String(label), hint, `${entry.page}: ${entry.label}`);
  return (
    <label className={cn('flex items-center justify-between gap-2 my-1', className)}>
      {label !== undefined && (
        <DocHover entry={entry} fallback={hint} affordance='field' className={cn(labelClass, 'w-[70px] shrink-0', labelClassName)}>
          {label}
        </DocHover>
      )}
      {children}
    </label>
  );
}

/** Muted caption / helper text used beneath controls and sections. */
export function Hint({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn(hintClass, 'mt-0.5', className)}>{children}</p>;
}

export default Field;

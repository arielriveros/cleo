import React from 'react';
import { cn } from './cn';
import { hintClass, labelClass } from './typography';

export interface FieldProps {
  label?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  labelClassName?: string;
  /** Native tooltip on the label, for explanation that would otherwise be a paragraph under the control. */
  hint?: string;
}

/** A labeled control row: fixed-width label on the left, control filling the rest. */
export function Field({ label, children, className, labelClassName, hint }: FieldProps) {
  return (
    <label className={cn('flex items-center justify-between gap-2 my-1', className)}>
      {label !== undefined && (
        <span
          className={cn(labelClass, 'w-[70px] shrink-0', hintAffordance(hint), labelClassName)}
          title={hint}
        >
          {label}
        </span>
      )}
      {children}
    </label>
  );
}

/** The dotted-underline + help-cursor treatment that marks a label as carrying a tooltip. */
export function hintAffordance(hint?: string): string | undefined {
  return hint ? 'cursor-help decoration-dotted underline underline-offset-2' : undefined;
}

/** Muted caption / helper text used beneath controls and sections. */
export function Hint({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn(hintClass, 'mt-0.5', className)}>{children}</p>;
}

export default Field;

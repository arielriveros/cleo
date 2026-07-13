import React from 'react';
import { cn } from './cn';
import { hintClass, labelClass } from './typography';

export interface FieldProps {
  label?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  labelClassName?: string;
}

/** A labeled control row: fixed-width label on the left, control filling the rest. */
export function Field({ label, children, className, labelClassName }: FieldProps) {
  return (
    <label className={cn('flex items-center justify-between gap-2 my-1', className)}>
      {label !== undefined && <span className={cn(labelClass, 'w-[70px] shrink-0', labelClassName)}>{label}</span>}
      {children}
    </label>
  );
}

/** Muted caption / helper text used beneath controls and sections. */
export function Hint({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn(hintClass, 'mt-0.5', className)}>{children}</p>;
}

export default Field;

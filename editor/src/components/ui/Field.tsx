import React from 'react';
import { cn } from './cn';

export interface FieldProps {
  label?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  labelClassName?: string;
}

/** A labeled control row: fixed-width label on the left, control filling the rest. */
export function Field({ label, children, className, labelClassName }: FieldProps) {
  return (
    <label className={cn('flex items-center justify-between gap-2 my-1 text-xs', className)}>
      {label !== undefined && <span className={cn('w-[70px] shrink-0', labelClassName)}>{label}</span>}
      {children}
    </label>
  );
}

/** Muted caption / helper text used beneath controls and sections. */
export function Hint({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn('text-[10px] text-dim mt-0.5', className)}>{children}</p>;
}

export default Field;

import React from 'react';
import { cn } from './cn';

export interface CheckboxProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'type'> {
  label?: React.ReactNode;
  onChange?: (checked: boolean) => void;
  labelClassName?: string;
}

/** Native checkbox tinted with the primary accent; wraps in a clickable label when `label` is set. */
export function Checkbox({ label, checked, onChange, className, labelClassName, ...rest }: CheckboxProps) {
  const input = (
    <input
      type='checkbox'
      checked={checked}
      onChange={(e) => onChange?.(e.target.checked)}
      className={cn('accent-primary', className)}
      {...rest}
    />
  );
  if (label === undefined) return input;
  return (
    <label className={cn('flex items-center gap-2 text-xs cursor-pointer select-none', labelClassName)}>
      {input}
      {label}
    </label>
  );
}

export default Checkbox;

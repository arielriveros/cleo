import React from 'react';
import { cn } from './cn';

// Shared control chrome — the token-based replacement for the grey-fill/indigo-border input
// string that used to be copy-pasted across inspectors.
export const controlClass = 'bg-control text-white border border-border rounded px-2 py-1 outline-none focus-visible:border-primary';

export interface NumberInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'type'> {
  value: number;
  onChange: (value: number) => void;
}

/** Styled numeric input. Emits a finite number (falls back to 0 on empty/invalid). */
export function NumberInput({ value, onChange, className, ...rest }: NumberInputProps) {
  return (
    <input
      type='number'
      value={Number.isFinite(value) ? value : ''}
      onChange={(e) => {
        const v = parseFloat(e.target.value);
        onChange(Number.isFinite(v) ? v : 0);
      }}
      className={cn(controlClass, 'w-full tabular-nums', className)}
      {...rest}
    />
  );
}

export interface TextInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'type'> {
  value: string;
  onChange: (value: string) => void;
}

/** Styled single-line text input. */
export function TextInput({ value, onChange, className, ...rest }: TextInputProps) {
  return (
    <input
      type='text'
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(controlClass, 'w-full', className)}
      {...rest}
    />
  );
}

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {}

/** Styled native `<select>`. Pass `<option>`s as children. */
export function Select({ className, children, ...rest }: SelectProps) {
  return (
    <select className={cn(controlClass, className)} {...rest}>
      {children}
    </select>
  );
}

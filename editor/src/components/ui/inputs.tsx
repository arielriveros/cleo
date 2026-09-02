import React from 'react';
import { cn } from './cn';

// Shared control chrome. It carries its own type (type-value) so a control is the same size wherever
// it is hosted, including in a bare table cell.
export const controlClass = 'type-value bg-control text-white border border-border rounded px-2 py-1 outline-none focus-visible:border-primary';

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

/** Styled single-line text input. Ref-forwarding so DialogHost can focus and select a prompt's value. */
export const TextInput = React.forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { value, onChange, className, ...rest },
  ref
) {
  return (
    <input
      ref={ref}
      type='text'
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(controlClass, 'w-full', className)}
      {...rest}
    />
  );
});

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {}

/** Styled native `<select>`. Pass `<option>`s as children. */
export function Select({ className, children, ...rest }: SelectProps) {
  return (
    <select className={cn(controlClass, className)} {...rest}>
      {children}
    </select>
  );
}

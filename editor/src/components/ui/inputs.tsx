import React from 'react';
import { cn } from './cn';

// Shared control chrome. It carries its own type (type-value) so a control is the same size wherever
// it is hosted, including in a bare table cell.
export const controlClass = 'type-value bg-control text-fg border border-border rounded px-2 py-1 outline-none focus-visible:border-primary';

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

export interface OptionalNumberInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'type'> {
  /** `undefined` shows an empty box (pair it with a `placeholder` naming the default). */
  value: number | undefined;
  /** A number while the text parses; `undefined` when the box is cleared. */
  onChange: (value: number | undefined) => void;
}

/**
 * A number field where EMPTY means "not set" — a per-transition blend time that falls back to the
 * machine default, an IK weight that inherits. {@link NumberInput} cannot say that: it turns a cleared box
 * into 0. Half-typed text ("-", "1.") stays in the box without being emitted, so negatives and decimals
 * can be typed; the box re-syncs to `value` whenever it is not being edited.
 */
export function OptionalNumberInput({ value, onChange, className, onFocus, onBlur, onKeyDown, step, min, max, ...rest }: OptionalNumberInputProps) {
  const shown = value === undefined || !Number.isFinite(value) ? '' : String(value);
  const [draft, setDraft] = React.useState<string | null>(null);
  // A text box (so a blank or a half-typed "-" can be held), but it keeps the number field's ArrowUp /
  // ArrowDown nudge by `step`, clamped to min / max — fields that used `type=number` relied on it.
  const nudge = (dir: 1 | -1) => {
    const by = Number(step) > 0 ? Number(step) : 1;
    let next = (value ?? 0) + dir * by;
    if (min !== undefined && Number.isFinite(Number(min))) next = Math.max(Number(min), next);
    if (max !== undefined && Number.isFinite(Number(max))) next = Math.min(Number(max), next);
    next = Math.round(next / by) * by;
    next = Number(next.toFixed(6));
    setDraft(String(next));
    onChange(next);
  };
  return (
    <input
      type='text'
      inputMode='decimal'
      value={draft ?? shown}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); nudge(e.key === 'ArrowUp' ? 1 : -1); }
        onKeyDown?.(e);
      }}
      onFocus={(e) => { setDraft(shown); onFocus?.(e); }}
      onBlur={(e) => { setDraft(null); onBlur?.(e); }}
      onChange={(e) => {
        const text = e.target.value;
        setDraft(text);
        if (text.trim() === '') { onChange(undefined); return; }
        const v = Number(text);
        if (Number.isFinite(v)) onChange(v);
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

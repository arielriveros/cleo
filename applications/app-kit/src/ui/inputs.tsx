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

/**
 * What a name field commits when it is left (Enter or blur): the trimmed draft when it is valid and different, else
 * null (nothing to commit: the field goes back to `value`). `validate` returns why a name will not do, or null.
 */
export function nameCommit(value: string, draft: string, validate?: (name: string) => string | null): string | null {
  const next = draft.trim();
  if (next === value) return null;
  if (validate?.(next)) return null;
  return next || null;
}

export interface NameInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'type' | 'onBlur' | 'onKeyDown'> {
  value: string;
  /** The new name, once it is committed (Enter, or leaving the field) and valid. */
  onCommit: (name: string) => void;
  /** Why a draft will not do (taken, empty...), or null. Shown on the field while it is typed. */
  validate?: (name: string) => string | null;
}

/**
 * A field for a NAME that other things refer to (a state, a parameter, a layer). Typing edits a draft only: the
 * name changes once, on Enter or on leaving the field, so a rename is not run per keystroke (half-typed names
 * colliding with others, the row keyed by the name remounting under the caret). Escape puts the name back. An
 * invalid draft is marked and says why; left invalid, the field goes back to the name.
 */
export function NameInput({ value, onCommit, validate, className, title, ...rest }: NameInputProps) {
  const [draft, setDraft] = React.useState<string | null>(null);
  // Escape leaves the field without committing: blur would commit otherwise.
  const cancelled = React.useRef(false);
  const shown = draft ?? value;
  const problem = draft !== null && draft.trim() !== value ? validate?.(draft) ?? null : null;
  return (
    <input
      type='text'
      value={shown}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const was = draft;
        setDraft(null);
        if (cancelled.current) { cancelled.current = false; return; }
        const next = was === null ? null : nameCommit(value, was, validate);
        if (next !== null) onCommit(next);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') { cancelled.current = true; e.currentTarget.blur(); }
      }}
      aria-invalid={problem ? true : undefined}
      title={problem ?? title}
      className={cn(controlClass, 'w-full', problem && 'border-warning focus-visible:border-warning', className)}
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

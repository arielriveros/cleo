import React from 'react';
import { cn } from './cn';
import { DocHover } from './DocTooltip';
import { useDocEntry } from '../../features/docs/DocScope';

export interface ToggleProps {
  checked: boolean;
  /** The click event rides along for the rare toggle that reads modifiers (Alt-click = whole branch). */
  onChange: (checked: boolean, event: React.MouseEvent<HTMLButtonElement>) => void;
  label?: React.ReactNode;
  disabled?: boolean;
  className?: string;
  /**
   * Native tooltip. On the button itself, so it covers the track as well as the label. Unused when the
   * label names a row of its section's docs, whose card is shown on the label instead.
   */
  title?: string;
  /** Docs key for the label when its text is not the term (see resolveDocKey); `false` opts out. */
  doc?: string | false;
}

/** Pill on/off switch (primary when on). The whole control — track + optional label — is one button. */
export function Toggle({ checked, onChange, label, disabled, className, title, doc }: ToggleProps) {
  const entry = useDocEntry(label, doc, 'field');
  return (
    <button
      type='button'
      role='switch'
      aria-checked={checked}
      disabled={disabled}
      title={entry ? undefined : title}
      onClick={(e) => onChange(!checked, e)}
      className={cn('inline-flex items-center gap-2 text-ui select-none disabled:opacity-60 disabled:cursor-not-allowed', className)}
    >
      <span
        className={cn(
          'relative inline-flex h-[16px] w-[28px] shrink-0 items-center rounded-full border transition-colors',
          checked ? 'bg-primary border-primary-active' : 'bg-control border-border'
        )}
      >
        <span
          className={cn(
            'inline-block h-[12px] w-[12px] rounded-full bg-fg shadow transition-transform',
            checked ? 'translate-x-[13px]' : 'translate-x-[2px]'
          )}
        />
      </span>
      {label !== undefined && <DocHover entry={entry} affordance='field' className='text-left'>{label}</DocHover>}
    </button>
  );
}

export default Toggle;

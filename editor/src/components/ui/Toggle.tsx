import React from 'react';
import { cn } from './cn';

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: React.ReactNode;
  disabled?: boolean;
  className?: string;
  /** Native tooltip. On the button itself, so it covers the track as well as the label. */
  title?: string;
}

/** Pill on/off switch (primary when on). The whole control — track + optional label — is one button. */
export function Toggle({ checked, onChange, label, disabled, className, title }: ToggleProps) {
  return (
    <button
      type='button'
      role='switch'
      aria-checked={checked}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!checked)}
      className={cn('inline-flex items-center gap-2 text-xs select-none disabled:opacity-60 disabled:cursor-not-allowed', className)}
    >
      <span
        className={cn(
          'relative inline-flex h-[16px] w-[28px] shrink-0 items-center rounded-full border transition-colors',
          checked ? 'bg-primary border-primary-active' : 'bg-control border-border'
        )}
      >
        <span
          className={cn(
            'inline-block h-[12px] w-[12px] rounded-full bg-white shadow transition-transform',
            checked ? 'translate-x-[13px]' : 'translate-x-[2px]'
          )}
        />
      </span>
      {label !== undefined && <span className='text-left'>{label}</span>}
    </button>
  );
}

export default Toggle;

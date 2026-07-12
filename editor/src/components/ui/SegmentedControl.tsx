import React from 'react';
import { cva } from 'class-variance-authority';
import { cn } from './cn';

const segment = cva(
  'flex items-center justify-center gap-1 border transition-colors',
  {
    variants: {
      size: {
        sm: 'px-1 py-1 text-[11px]',
        md: 'px-2 py-1 text-xs',
      },
      active: {
        true: 'bg-selected border-white text-white',
        false: 'bg-control border-control text-muted hover:bg-control-hover hover:text-white',
      },
      disabled: {
        true: 'opacity-50 pointer-events-none',
        false: 'cursor-pointer',
      },
    },
    defaultVariants: { size: 'md', active: false, disabled: false },
  }
);

export interface SegmentedOption<T> {
  value: T;
  label: React.ReactNode;
  title?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string | number> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  /** Extra classes for the container (e.g. `grid grid-cols-3 gap-1`). Default is an inline flex row. */
  className?: string;
  itemClassName?: string;
  /** Stretch each item to fill the row/cell. */
  grow?: boolean;
  rounded?: boolean;
}

/**
 * A row (or grid) of mutually-exclusive buttons. Unifies the mode selector, gizmo toolbar,
 * and the renderer debug-channel / quality / plane pickers.
 */
export function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
  size = 'md',
  className,
  itemClassName,
  grow = false,
  rounded = true,
}: SegmentedControlProps<T>) {
  return (
    <div className={cn('inline-flex items-center gap-1', className)}>
      {options.map((opt) => (
        <button
          key={String(opt.value)}
          type='button'
          title={opt.title}
          disabled={opt.disabled}
          onClick={() => onChange(opt.value)}
          className={cn(
            segment({ size, active: value === opt.value, disabled: opt.disabled }),
            rounded && 'rounded',
            grow && 'flex-1',
            itemClassName
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export default SegmentedControl;

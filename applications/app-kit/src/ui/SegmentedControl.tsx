import React from 'react';
import { cva } from 'class-variance-authority';
import { cn } from './cn';
import { useDocTooltip } from './DocTooltip';
import { useDocEntry } from '../docs/DocScope';

const segment = cva(
  'flex items-center justify-center gap-1 border transition-colors',
  {
    variants: {
      size: {
        sm: 'px-1 py-1 text-ui-sm',
        md: 'px-2 py-1 text-ui',
      },
      active: {
        true: 'bg-selected border-fg text-fg',
        false: 'bg-control border-control text-muted hover:bg-control-hover hover:text-fg',
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
  /**
   * The docs entry this option names (a page tab, a catalog category): a term, `page#anchor` or
   * `page[#anchor]::Term`. When it resolves, its hover card replaces `title`.
   */
  doc?: string;
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
  /**
   * One strip, `[ a | b | c ]`: a single rounded border round the group, dividers between the items,
   * no gaps. For groups of icon buttons in a viewport's chrome. `rounded` and `className`'s layout are
   * ignored for the items (the strip owns the border).
   */
  joined?: boolean;
}

/**
 * The frame of a joined group of buttons (`[ a | b | c ]`): one border round them all. A strip that
 * mixes kinds of control (a menu trigger, a toggle) uses it with {@link JOINED_DIVIDER_CLASS} on every
 * item after the first; `SegmentedControl joined` draws the same thing for a plain choice.
 */
export const JOINED_GROUP_CLASS = 'inline-flex items-stretch rounded border border-control-hover overflow-hidden bg-surface-raised/80';
/** The divider on every item of a joined group after the first. */
export const JOINED_DIVIDER_CLASS = 'border-l border-control-hover';

const joinedSegment = cva(
  'flex items-center justify-center gap-1 transition-colors',
  {
    variants: {
      size: {
        sm: 'px-1 py-1 text-ui-sm',
        md: 'px-2 py-1 text-ui',
      },
      active: {
        true: 'bg-selected text-fg',
        false: 'text-muted hover:bg-surface-raised hover:text-fg',
      },
      disabled: {
        true: 'opacity-50 pointer-events-none',
        false: 'cursor-pointer',
      },
    },
    defaultVariants: { size: 'md', active: false, disabled: false },
  }
);

/**
 * A row (or grid) of mutually-exclusive buttons.
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
  joined = false,
}: SegmentedControlProps<T>) {
  if (joined) {
    return (
      <div className={cn(JOINED_GROUP_CLASS, className)}>
        {options.map((opt, i) => (
          <Segment
            key={String(opt.value)}
            option={opt}
            onClick={() => onChange(opt.value)}
            className={cn(
              joinedSegment({ size, active: value === opt.value, disabled: opt.disabled }),
              i > 0 && JOINED_DIVIDER_CLASS,
              grow && 'flex-1',
              itemClassName
            )}
          />
        ))}
      </div>
    );
  }
  return (
    <div className={cn('inline-flex items-center gap-1', className)}>
      {options.map((opt) => (
        <Segment
          key={String(opt.value)}
          option={opt}
          onClick={() => onChange(opt.value)}
          className={cn(
            segment({ size, active: value === opt.value, disabled: opt.disabled }),
            rounded && 'rounded',
            grow && 'flex-1',
            itemClassName
          )}
        />
      ))}
    </div>
  );
}

function Segment<T>({ option, onClick, className }: { option: SegmentedOption<T>; onClick: () => void; className: string }) {
  const entry = useDocEntry(undefined, option.doc ?? false);
  const tip = useDocTooltip(entry);
  return (
    <button
      ref={tip.ref}
      {...tip.hoverProps}
      type='button'
      title={entry ? undefined : option.title}
      aria-describedby={tip.describedBy}
      disabled={option.disabled}
      onClick={onClick}
      onFocus={(e) => { if (e.currentTarget.matches(':focus-visible')) tip.show(); }}
      onBlur={tip.hide}
      className={className}
    >
      {option.label}
      {tip.card}
    </button>
  );
}

export default SegmentedControl;

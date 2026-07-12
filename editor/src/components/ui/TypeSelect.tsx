import React from 'react';
import { cn } from './cn';
import { Popover } from './Popover';
import { typeMeta } from './dataTypes';

export interface TypeSelectProps<T extends string> {
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}

const Dot = ({ color }: { color: string }) => (
  <span className='w-2.5 h-2.5 rounded-full shrink-0 ring-1 ring-black/30' style={{ background: color }} />
);

/**
 * Color-coded data-type selector. Collapsed it shows only the current type's colored dot;
 * open, it lists every type as a colored dot + label. Backed by `dataTypes`.
 */
export function TypeSelect<T extends string>({ value, options, onChange, disabled, className }: TypeSelectProps<T>) {
  const cur = typeMeta(value);
  return (
    <Popover
      disabled={disabled}
      title={`Type: ${cur.label}`}
      triggerClassName={cn(
        'inline-flex items-center gap-1 rounded border border-border bg-control px-1.5 py-1 hover:bg-control-hover disabled:opacity-60 transition-colors',
        className
      )}
      trigger={<><Dot color={cur.color} /><span className='text-[9px] text-muted'>▼</span></>}
    >
      {(close) => (
        <div className='min-w-[132px] flex flex-col'>
          {options.map((opt) => {
            const m = typeMeta(opt);
            return (
              <button
                key={opt}
                type='button'
                onClick={() => { onChange(opt); close(); }}
                className={cn('flex items-center gap-2 px-2 py-1 rounded text-xs text-left hover:bg-control transition-colors', opt === value && 'bg-control')}
              >
                <Dot color={m.color} />
                <span className='truncate'>{m.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </Popover>
  );
}

export default TypeSelect;

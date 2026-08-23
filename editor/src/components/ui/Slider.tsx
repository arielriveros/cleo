import React, { useState } from 'react';
import { cn } from './cn';
import { labelClass, valueClass } from './typography';

export interface SliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  label?: React.ReactNode;
  /** Show the numeric readout on the right. `true` -> `value.toFixed(2)`; pass a fn to format. */
  readout?: boolean | ((value: number) => string);
  /** Let the user click the readout to type an exact value (default true). */
  editable?: boolean;
  className?: string;
  labelClassName?: string;
  /** Native tooltip covering the whole control. Falls back to the label text when omitted. */
  title?: string;
}

/**
 * Labeled range slider with a value-proportional filled track and an optional click-to-edit
 * numeric readout. The fill is driven by the `--slider-fill` CSS var (see index.css track rules).
 */
export function Slider({
  value,
  min,
  max,
  step = 0.01,
  onChange,
  label,
  readout = true,
  editable = true,
  className,
  labelClassName,
  title,
}: SliderProps) {
  const [editing, setEditing] = useState(false);
  const pct = max > min ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0;
  const text = typeof readout === 'function' ? readout(value) : value.toFixed(2);

  const commit = (raw: string) => {
    const v = parseFloat(raw);
    if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
    setEditing(false);
  };

  return (
    <label className={cn('flex items-center gap-2 my-1', valueClass, className)} title={title}>
      {label !== undefined && <span className={cn(labelClass, 'w-[70px] shrink-0 truncate', labelClassName)} title={title ?? (typeof label === 'string' ? label : undefined)}>{label}</span>}
      <input
        className='flex-1 min-w-0'
        style={{ ['--slider-fill' as any]: pct + '%' }}
        type='range'
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      {readout !== false && (
        editable && editing ? (
          <input
            type='number'
            autoFocus
            defaultValue={value}
            min={min}
            max={max}
            step={step}
            onClick={(e) => e.preventDefault()}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
              else if (e.key === 'Escape') setEditing(false);
            }}
            className='w-[46px] shrink-0 bg-control border border-border rounded px-1 text-right text-[11px] tabular-nums outline-none focus-visible:border-primary'
          />
        ) : (
          <span
            className={cn('w-[46px] text-right tabular-nums shrink-0', editable && 'cursor-text hover:text-white')}
            title={editable ? 'Click to edit' : undefined}
            onClick={(e) => { if (editable) { e.preventDefault(); setEditing(true); } }}
          >
            {text}
          </span>
        )
      )}
    </label>
  );
}

export default Slider;

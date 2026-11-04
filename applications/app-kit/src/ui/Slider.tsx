import React, { useState } from 'react';
import { cn } from './cn';
import { labelClass, valueClass } from './typography';
import { clamp } from '../utils/math';
import { DocHover } from './DocTooltip';
import { useDocEntry } from '../docs/DocScope';

/**
 * The track fill for a 0..1 position: up to the thumb's centre, which travels from 7px to 100% - 7px
 * (the thumb is 14px), not from 0 to 100%. For a raw `<input type='range'>` styled by the theme too.
 */
export const sliderFill = (fraction: number): string =>
  `calc(7px + (100% - 14px) * ${Math.min(1, Math.max(0, fraction)).toFixed(4)})`;

/**
 * The default readout: two decimals, or as many as the step has (up to four), so a 0.001 step reads
 * 0.003 rather than 0.00; a value too small for those decimals keeps two significant digits.
 */
export function sliderReadout(value: number, step = 0.01): string {
  const s = String(step);
  const stepDecimals = s.includes('e-') ? Number(s.split('e-')[1]) : s.includes('.') ? s.length - s.indexOf('.') - 1 : 0;
  const d = Math.min(4, Math.max(2, stepDecimals));
  if (value !== 0 && Math.abs(value) < 0.5 * Math.pow(10, -d)) return value.toPrecision(2);
  return value.toFixed(d);
}

export interface SliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  label?: React.ReactNode;
  /** Show the numeric readout on the right. `true` -> {@link sliderReadout}; pass a fn to format. */
  readout?: boolean | ((value: number) => string);
  /** Let the user click the readout to type an exact value (default true). */
  editable?: boolean;
  className?: string;
  labelClassName?: string;
  /**
   * Native tooltip covering the whole control. Falls back to the label text when omitted. Unused when the
   * label names a row of its section's docs, whose card is shown on the label instead.
   */
  title?: string;
  /** Docs key for the label when its text is not the term (see resolveDocKey); `false` opts out. */
  doc?: string | false;
}

/**
 * Labeled range slider with a value-proportional filled track and an optional click-to-edit
 * numeric readout. The fill is driven by the `--slider-fill` CSS var (see the track rules in
 * styles/theme.css); {@link sliderFill} puts its end under the thumb's centre.
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
  doc,
}: SliderProps) {
  const [editing, setEditing] = useState(false);
  const entry = useDocEntry(label, doc, 'field');
  const pct = max > min ? clamp(((value - min) / (max - min)) * 100, 0, 100) : 0;
  const text = typeof readout === 'function' ? readout(value) : sliderReadout(value, step);

  const commit = (raw: string) => {
    const v = parseFloat(raw);
    if (Number.isFinite(v)) onChange(clamp(v, min, max));
    setEditing(false);
  };

  return (
    <label className={cn('flex items-center gap-2 my-1', valueClass, className)} title={entry ? undefined : title}>
      {label !== undefined && (
        <DocHover entry={entry} fallback={title ?? (typeof label === 'string' ? label : undefined)}
          affordance='field' className={cn(labelClass, 'w-[70px] shrink-0 truncate', labelClassName)}>
          {label}
        </DocHover>
      )}
      <input
        className='flex-1 min-w-0'
        style={{ ['--slider-fill' as any]: sliderFill(pct / 100) }}
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
            className='w-[46px] shrink-0 bg-control border border-border rounded px-1 text-right text-ui-sm tabular-nums outline-none focus-visible:border-primary'
          />
        ) : (
          <span
            className={cn('w-[46px] text-right tabular-nums shrink-0', editable && 'cursor-text hover:text-fg')}
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

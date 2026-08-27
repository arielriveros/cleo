import React, { useEffect, useRef, useState } from 'react';
import { cn } from './cn';

const AXIS_VARS = ['--axis-x', '--axis-y', '--axis-z', '--highlight'];
const axisColor = (i: number) => `rgb(var(${AXIS_VARS[i] ?? '--muted'}))`;
const axisTint = (i: number) => `rgb(var(${AXIS_VARS[i] ?? '--muted'}) / 0.16)`;

export interface VectorInputProps {
  value: number[];
  onChange: (value: number[]) => void;
  /** Per-component labels; defaults to X/Y/Z/W. Pass `[]` to hide labels. */
  labels?: string[];
  step?: number;
  min?: number;
  max?: number;
  /** Tint each component's label with its axis color (default true). */
  axisColors?: boolean;
  /** Lock components to a common ratio (uniform scaling). */
  uniform?: boolean;
  /** Values applied when a component's label is double-clicked. */
  reset?: number[];
  /** Decimals shown when not editing (default 2). */
  precision?: number;
  disabled?: boolean;
  className?: string;
}

/**
 * Generalized numeric vector field (vec2/vec3/vec4/scalar). Each component has a colored, draggable
 * axis label (pointer-lock, clamped to min/max) and a click-to-type input.
 */
export function VectorInput({
  value,
  onChange,
  labels = ['X', 'Y', 'Z', 'W'],
  step = 0.1,
  min,
  max,
  axisColors = true,
  uniform = false,
  reset,
  precision = 2,
  disabled = false,
  className,
}: VectorInputProps) {
  const [editing, setEditing] = useState<{ i: number; draft: string } | null>(null);
  const dragging = useRef<number | null>(null);
  // Latest props for the document-level drag listener (added once).
  const latest = useRef({ value, onChange, step, min, max, uniform });
  latest.current = { value, onChange, step, min, max, uniform };

  const clamp = (v: number) => {
    const { min: lo, max: hi } = latest.current;
    if (lo !== undefined) v = Math.max(lo, v);
    if (hi !== undefined) v = Math.min(hi, v);
    return v;
  };

  // Honors the uniform (ratio) lock.
  const applyAt = (i: number, next: number) => {
    const { value: cur, uniform: u, onChange: cb } = latest.current;
    if (u) {
      const old = cur[i];
      if (old !== 0 && Number.isFinite(old)) { const r = next / old; cb(cur.map((v) => v * r)); return; }
      cb(cur.map(() => next)); return;
    }
    const out = [...cur]; out[i] = next; cb(out);
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const i = dragging.current;
      if (i === null) return;
      const { value: cur, step: s } = latest.current;
      applyAt(i, clamp(cur[i] + e.movementX * s));
    };
    const onUp = () => { if (dragging.current !== null) { dragging.current = null; try { document.exitPointerLock(); } catch { /* ignore */ } } };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, []);

  const fmt = (v: number) => (Number.isFinite(v) ? String(Number(v.toFixed(precision))) : '0');

  return (
    <div className={cn('flex items-stretch gap-1 w-full', disabled && 'opacity-60 pointer-events-none', className)}>
      {value.map((v, i) => {
        const label = labels[i];
        const color = axisColors ? axisColor(i) : 'rgb(var(--muted))';
        return (
          <div key={i} className='flex items-center flex-1 min-w-0 rounded border border-border bg-control overflow-hidden focus-within:border-primary transition-colors'>
            {label !== undefined && (
              <span
                className='px-1.5 self-stretch flex items-center text-[10px] font-bold select-none cursor-ew-resize'
                style={{ color, background: axisColors ? axisTint(i) : 'transparent' }}
                title={`Drag to adjust${reset ? ' · double-click to reset' : ''}`}
                onMouseDown={(e) => { e.preventDefault(); dragging.current = i; (e.currentTarget as any).requestPointerLock?.(); }}
                onDoubleClick={() => { if (reset) applyAt(i, clamp(reset[i] ?? 0)); }}
              >
                {label}
              </span>
            )}
            <input
              type='number'
              step={step}
              min={min}
              max={max}
              disabled={disabled}
              value={editing?.i === i ? editing.draft : fmt(v)}
              onFocus={() => setEditing({ i, draft: String(v) })}
              onBlur={() => setEditing(null)}
              onChange={(e) => {
                const s = e.target.value;
                setEditing({ i, draft: s });
                const n = parseFloat(s);
                if (Number.isFinite(n)) applyAt(i, clamp(n));
              }}
              className='w-full min-w-0 bg-transparent px-1.5 py-1 text-xs tabular-nums outline-none'
            />
          </div>
        );
      })}
    </div>
  );
}

export default VectorInput;

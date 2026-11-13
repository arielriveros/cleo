import React from 'react';
import { cn } from '../ui/cn';
import { formatTick, rulerTicks, timeToX } from './timelineMath';

export interface TimeRulerProps {
  /** The visible time range: only its ticks are drawn. */
  from: number;
  to: number;
  pxPerSec: number;
  /** The content's left margin, as the lanes under it use. */
  gutter?: number;
  height?: number;
  /** Pressed on the ruler: start a scrub (the caller follows the drag). */
  onPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
  /** Labelled flags on the ruler (a sequence's markers). */
  markers?: { t: number; name: string; selected?: boolean }[];
  onMarkerPointerDown?: (index: number, e: React.PointerEvent<HTMLElement>) => void;
  className?: string;
}

/**
 * A time ruler for a horizontally scrolled timeline: adaptive major ticks with labels, four minor ticks
 * between them, and optional markers. Sits inside the scrolled content, so ticks scroll with the lanes.
 */
export function TimeRuler({ from, to, pxPerSec, gutter = 0, height = 22, onPointerDown, markers, onMarkerPointerDown, className }: TimeRulerProps) {
  const ticks = rulerTicks(Math.max(0, from), to, pxPerSec);
  return (
    <div className={cn('absolute inset-x-0 top-0 cursor-ew-resize select-none border-b border-border bg-surface-raised', className)}
      style={{ height }} onPointerDown={onPointerDown}>
      {ticks.map(({ t, major }) => (
        <div key={t.toFixed(4)} className='absolute bottom-0 border-l border-border' style={{ left: timeToX(t, pxPerSec, gutter), height: major ? 10 : 5 }}>
          {major && <span className='absolute -top-3 left-1 whitespace-nowrap text-ui-2xs tabular-nums text-dim'>{formatTick(t)}</span>}
        </div>
      ))}
      {markers?.map((m, i) => (
        // Only the flag takes the pointer: the rest of the ruler under a marker still scrubs.
        <div key={i}
          className={cn('pointer-events-none absolute top-0 flex h-full -translate-x-[1px] items-start', m.selected ? 'text-highlight' : 'text-warning')}
          style={{ left: timeToX(m.t, pxPerSec, gutter) }}>
          <div className='h-full border-l border-current' />
          <span title={m.name} className='pointer-events-auto ml-0.5 max-w-[120px] cursor-grab truncate rounded-sm bg-surface px-0.5 text-ui-2xs leading-[11px]'
            onPointerDown={e => { e.stopPropagation(); onMarkerPointerDown?.(i, e); }}>{m.name}</span>
        </div>
      ))}
    </div>
  );
}

import { useRef, useState } from 'react';
import { NumberInput, cn } from '../ui';

/**
 * A pass band with soft edges over a value's distribution: the band [min, max] passes fully, and the
 * falloffs fade it out below and above -- the shape of a terrain selector in World Machine or Gaea, drawn
 * over a histogram of the value it selects on, so the user sees how much of the map a band takes.
 *
 * Drag a band edge to move it, a falloff end to widen that fade, or the band's middle to slide it; the
 * numbers below take exact values. Pure UI: the parent owns the four numbers.
 */
export interface RangeFalloffValue { min: number; max: number; falloffLow: number; falloffHigh: number }

export interface RangeFalloffFieldProps extends RangeFalloffValue {
  /** The span the graph covers. */
  domain: [number, number];
  step?: number;
  unit?: string;
  /** Counts per equal bin across `domain` (any length); drawn behind the band. */
  histogram?: ArrayLike<number> | null;
  /** Draw the band inverted (what passes is outside it). */
  invert?: boolean;
  onChange: (patch: Partial<RangeFalloffValue>, coalesce?: boolean) => void;
  className?: string;
}

const W = 260, H = 56, PAD = 6;

const smooth = (a: number, b: number, x: number) => {
  if (b <= a) return x < a ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

type Handle = 'min' | 'max' | 'lowEnd' | 'highEnd' | 'band';

export function RangeFalloffField({ min, max, falloffLow, falloffHigh, domain, step = 0.01, unit, histogram, invert, onChange, className }: RangeFalloffFieldProps) {
  const svg = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ handle: Handle; start: number; from: RangeFalloffValue } | null>(null);
  const [lo, hi] = domain;
  const span = hi - lo || 1;
  const toX = (v: number) => PAD + ((v - lo) / span) * (W - 2 * PAD);
  const toV = (x: number) => lo + ((x - PAD) / (W - 2 * PAD)) * span;
  const snap = (v: number) => Math.round(v / step) * step;

  // The pass curve, sampled across the graph.
  const curve: string[] = [];
  for (let i = 0; i <= 96; i++) {
    const v = lo + (i / 96) * span;
    const low = falloffLow > 0 ? smooth(min - falloffLow, min, v) : (v >= min ? 1 : 0);
    const high = falloffHigh > 0 ? 1 - smooth(max, max + falloffHigh, v) : (v <= max ? 1 : 0);
    let p = low * high;
    if (invert) p = 1 - p;
    curve.push(`${i ? 'L' : 'M'}${toX(v).toFixed(1)},${(H - PAD - p * (H - 2 * PAD)).toFixed(1)}`);
  }

  let bars: { x: number; w: number; h: number }[] = [];
  if (histogram && histogram.length) {
    let peak = 0;
    for (let i = 0; i < histogram.length; i++) peak = Math.max(peak, histogram[i]);
    const n = histogram.length;
    const bw = (W - 2 * PAD) / n;
    // Square root: a few huge bins (the sea floor, flat plains) must not flatten everything else.
    bars = Array.from({ length: n }, (_, i) => ({ x: PAD + i * bw, w: Math.max(1, bw - 0.5), h: peak > 0 ? Math.sqrt(histogram[i] / peak) * (H - 2 * PAD) : 0 }));
  }

  const pointerValue = (e: React.PointerEvent) => {
    const rect = svg.current!.getBoundingClientRect();
    return toV(((e.clientX - rect.left) / rect.width) * W);
  };
  const begin = (handle: Handle) => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    setDrag({ handle, start: pointerValue(e), from: { min, max, falloffLow, falloffHigh } });
  };
  const move = (e: React.PointerEvent) => {
    if (!drag) return;
    const v = pointerValue(e);
    const f = drag.from;
    switch (drag.handle) {
      case 'min': onChange({ min: snap(Math.min(v, f.max)) }, true); break;
      case 'max': onChange({ max: snap(Math.max(v, f.min)) }, true); break;
      case 'lowEnd': onChange({ falloffLow: snap(Math.max(0, f.min - v)) }, true); break;
      case 'highEnd': onChange({ falloffHigh: snap(Math.max(0, v - f.max)) }, true); break;
      case 'band': { const d = snap(v - drag.start); onChange({ min: f.min + d, max: f.max + d }, true); break; }
    }
  };

  const handle = (x: number, h: Handle, title: string, tall = true) => (
    <rect x={x - 3} y={tall ? PAD : H / 2 - 6} width={6} height={tall ? H - 2 * PAD : 12} rx={2}
          className={cn('cursor-ew-resize', tall ? 'fill-primary/70 hover:fill-primary' : 'fill-muted hover:fill-fg')} onPointerDown={begin(h)}>
      <title>{title}</title>
    </rect>
  );
  const clampX = (v: number) => Math.min(W - PAD, Math.max(PAD, toX(v)));

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <svg ref={svg} viewBox={`0 0 ${W} ${H}`} className='w-full h-14 rounded bg-surface-sunken select-none touch-none'
           onPointerMove={move} onPointerUp={() => setDrag(null)} onPointerCancel={() => setDrag(null)}>
        {bars.map((b, i) => <rect key={i} x={b.x} y={H - PAD - b.h} width={b.w} height={b.h} className='fill-muted/40' />)}
        <rect x={clampX(min)} y={PAD} width={Math.max(0, clampX(max) - clampX(min))} height={H - 2 * PAD}
              className='fill-primary/10 cursor-grab' onPointerDown={begin('band')}><title>Drag to slide the band</title></rect>
        <path d={curve.join(' ')} className='fill-none stroke-primary' strokeWidth={1.5} />
        {handle(clampX(min), 'min', 'Band start')}
        {handle(clampX(max), 'max', 'Band end')}
        {handle(clampX(min - falloffLow), 'lowEnd', 'Fade-in start', false)}
        {handle(clampX(max + falloffHigh), 'highEnd', 'Fade-out end', false)}
      </svg>
      <div className='grid grid-cols-4 gap-1 text-ui-xs text-dim'>
        <label className='flex flex-col'>Fade in<NumberInput value={falloffLow} step={step} min={0} onChange={v => onChange({ falloffLow: Math.max(0, v) })} /></label>
        <label className='flex flex-col'>From{unit ? ` (${unit})` : ''}<NumberInput value={min} step={step} onChange={v => onChange({ min: v })} /></label>
        <label className='flex flex-col'>To{unit ? ` (${unit})` : ''}<NumberInput value={max} step={step} onChange={v => onChange({ max: v })} /></label>
        <label className='flex flex-col'>Fade out<NumberInput value={falloffHigh} step={step} min={0} onChange={v => onChange({ falloffHigh: Math.max(0, v) })} /></label>
      </div>
    </div>
  );
}

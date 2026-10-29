import React, { useMemo, useRef, useState } from 'react';
import { evaluateCurve, type Curve, type CurveKey } from 'cleo';
import { Popover } from './Popover';
import { NumberInput } from './inputs';
import { Button } from './Button';
import { cn } from './cn';

export interface CurveInputProps {
  value: Curve;
  onChange: (value: Curve) => void;
  /** The value range shown when the keys sit inside it; the view grows to fit keys outside. */
  min?: number;
  max?: number;
  className?: string;
  title?: string;
}

const W = 300, H = 170;
const PAD = { left: 30, right: 10, top: 10, bottom: 20 };
const PW = W - PAD.left - PAD.right, PH = H - PAD.top - PAD.bottom;

const PRESETS: { label: string; curve: Curve }[] = [
  { label: 'Flat', curve: { keys: [{ t: 0, v: 1 }, { t: 1, v: 1 }] } },
  { label: 'Ramp up', curve: { keys: [{ t: 0, v: 0 }, { t: 1, v: 1 }] } },
  { label: 'Ramp down', curve: { keys: [{ t: 0, v: 1 }, { t: 1, v: 0 }] } },
  { label: 'Ease', curve: { keys: [{ t: 0, v: 0, outTangent: 0 }, { t: 1, v: 1, inTangent: 0 }] } },
  { label: 'Bell', curve: { keys: [{ t: 0, v: 0, outTangent: 0 }, { t: 0.5, v: 1, inTangent: 0, outTangent: 0 }, { t: 1, v: 0, inTangent: 0 }] } },
  { label: 'Pop', curve: { keys: [{ t: 0, v: 0 }, { t: 0.1, v: 1 }, { t: 1, v: 0.6 }] } },
];

/**
 * A view range: `[min, max]`, grown to fit every value outside it. CurveGraph uses it for both axes, so
 * keys outside the authored range stay on screen.
 */
export function graphRange(values: readonly number[], min: number, max: number): [number, number] {
  let lo = min, hi = max;
  for (const v of values) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (hi - lo < 1e-3) hi = lo + 1;
  return [lo, hi];
}

/** The y range the plot shows: the authored range, grown to fit every key with a little headroom. */
function viewRange(curve: Curve, min: number, max: number): [number, number] {
  return graphRange(curve.keys.map(k => k.v), min, max);
}

/** A dragged value: to the snap step when there is one, otherwise to three decimals. */
export function snapGraphValue(v: number, step?: number): number {
  const r = step && step > 0 ? Math.round(v / step) * step : v;
  const out = +r.toFixed(3);
  return Object.is(out, -0) ? 0 : out;
}

/** The curve as an SVG polyline in a `w` x `h` box. */
function pathOf(curve: Curve, w: number, h: number, lo: number, hi: number, x0 = 0, y0 = 0): string {
  const pts: string[] = [];
  const n = 48;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const v = evaluateCurve(curve, t);
    pts.push(`${(x0 + t * w).toFixed(1)},${(y0 + h - ((v - lo) / (hi - lo)) * h).toFixed(1)}`);
  }
  return 'M' + pts.join('L');
}

/**
 * A scalar curve over 0..1 — an inline sparkline that opens a key editor. Keys are dragged, added by
 * double-clicking empty space, and removed by double-clicking them; tangents are automatic (Catmull-Rom)
 * unless a preset sets them flat. The engine bakes the result into a LUT, so the key count is free.
 */
export function CurveInput({ value, onChange, min = 0, max = 1, className, title }: CurveInputProps) {
  const [lo, hi] = viewRange(value, min, max);
  const preview = useMemo(() => pathOf(value, 100, 20, lo, hi), [value, lo, hi]);

  return (
    <Popover
      title={title ?? 'Edit curve'}
      triggerClassName={cn('w-full', className)}
      className='p-2 w-[320px]'
      trigger={
        <span className='flex h-7 w-full items-center rounded border border-border bg-control px-1'>
          <svg viewBox='0 0 100 20' preserveAspectRatio='none' className='h-5 w-full'>
            <path d={preview} fill='none' stroke='currentColor' strokeWidth={1.5} className='text-primary' vectorEffect='non-scaling-stroke' />
          </svg>
        </span>
      }>
      <CurveEditor value={value} onChange={onChange} min={min} max={max} />
    </Popover>
  );
}

function CurveEditor({ value, onChange, min, max }: { value: Curve; onChange: (c: Curve) => void; min: number; max: number }) {
  return <CurveGraph keys={value.keys} onChange={keys => onChange({ keys })} min={min} max={max} />;
}

export interface CurveGraphProps {
  keys: CurveKey[];
  /** Every edit, with the keys sorted by `t`. */
  onChange: (keys: CurveKey[]) => void;
  /** The y range shown when the keys sit inside it; the view grows to fit keys outside. */
  min?: number;
  max?: number;
  /** The x range shown, grown the same way. */
  domain?: [number, number];
  /** What the line draws. Defaults to the engine's Hermite curve through the keys. */
  evaluate?: (x: number) => number;
  /** Linear between keys and held flat past the ends: drawn exactly through the keys, the held ends dashed. */
  linear?: boolean;
  /** Grid lines along x, each labelled. Without them: quarters, labelled at the ends only. */
  xTicks?: number[];
  xLabel?: string;
  yLabel?: string;
  /** Draw y = 0 stronger, for curves whose zero means "no change". */
  zeroLine?: boolean;
  /** A vertical line at some x, e.g. where a meter reads now. */
  marker?: { x: number, label: string };
  /** Drag steps; without them keys land on three decimals. */
  snap?: { x?: number, y?: number };
  /** Allow removing the last key; an empty graph still draws `evaluate`. */
  allowEmpty?: boolean;
  /** The selected key's field names. */
  keyLabels?: [string, string];
  /** Shape presets over 0..1, scaled into min..max. `[]` hides them. */
  presets?: { label: string; curve: Curve }[];
}

/**
 * A key graph: drag keys, double-click empty space to add one, double-click a key to remove it, and the
 * selected key gets two fields for exact values. CurveInput's popover is one (a 0..1 particle curve); the
 * exposure compensation curve is another, inline, over EV100.
 */
export function CurveGraph({
  keys, onChange, min = 0, max = 1, domain = [0, 1], evaluate, linear = false, xTicks, xLabel, yLabel,
  zeroLine = false, marker, snap, allowEmpty = false, keyLabels = ['t', 'v'], presets = PRESETS,
}: CurveGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [selected, setSelected] = useState<number | null>(null);
  // Frozen while dragging, so the view does not rescale under the cursor and run away with the key.
  const [frozen, setFrozen] = useState<{ x: [number, number], y: [number, number] } | null>(null);
  const [lo, hi] = frozen?.y ?? graphRange(keys.map(k => k.v), min, max);
  const [x0, x1] = frozen?.x ?? graphRange(keys.map(k => k.t), domain[0], domain[1]);
  const curve: Curve = { keys };
  const valueAt = evaluate ?? ((x: number) => evaluateCurve(curve, x));

  const px = (t: number) => PAD.left + ((t - x0) / (x1 - x0)) * PW;
  const py = (v: number) => PAD.top + PH - ((v - lo) / (hi - lo)) * PH;
  const toT = (x: number) => x0 + Math.min(1, Math.max(0, (x - PAD.left) / PW)) * (x1 - x0);
  const toV = (y: number) => lo + (1 - (y - PAD.top) / PH) * (hi - lo);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };

  const write = (next: CurveKey[]) => onChange([...next].sort((a, b) => a.t - b.t));

  const keyAt = (x: number, y: number) =>
    keys.findIndex(k => Math.hypot(px(k.t) - x, py(k.v) - y) < 7);

  const startDrag = (index: number) => {
    setSelected(index);
    setFrozen({ x: [x0, x1], y: [lo, hi] });
    const working = keys.map(k => ({ ...k }));
    const dragged = working[index];
    const move = (e: PointerEvent) => {
      const p = local(e);
      dragged.t = snapGraphValue(toT(p.x), snap?.x);
      dragged.v = snapGraphValue(toV(p.y), snap?.y);
      const sorted = [...working].sort((a, b) => a.t - b.t);
      setSelected(sorted.indexOf(dragged));
      write(working);
    };
    const up = () => {
      setFrozen(null);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const p = local(e);
    const i = keyAt(p.x, p.y);
    if (i >= 0) { e.preventDefault(); startDrag(i); }
    else setSelected(null);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const p = local(e);
    const i = keyAt(p.x, p.y);
    if (i >= 0) {
      if (keys.length <= 1 && !allowEmpty) return;
      write(keys.filter((_, j) => j !== i));
      setSelected(null);
      return;
    }
    write([...keys, { t: snapGraphValue(toT(p.x), snap?.x), v: snapGraphValue(toV(p.y), snap?.y) }]);
  };

  const sel = selected !== null ? keys[selected] : undefined;
  const setSel = (patch: Partial<CurveKey>) => {
    if (selected === null) return;
    write(keys.map((k, i) => (i === selected ? { ...k, ...patch } : k)));
  };

  // The line between two x values. A linear curve also samples at every key, so its corners are exact.
  const line = (from: number, to: number) => {
    const xs: number[] = [];
    const n = 48;
    for (let i = 0; i <= n; i++) xs.push(from + (i / n) * (to - from));
    if (linear) for (const k of keys) if (k.t > from && k.t < to) xs.push(k.t);
    xs.sort((a, b) => a - b);
    return 'M' + xs.map(x => `${px(x).toFixed(1)},${py(valueAt(x)).toFixed(1)}`).join('L');
  };
  const first = keys.length ? Math.min(...keys.map(k => k.t)) : x0;
  const last = keys.length ? Math.max(...keys.map(k => k.t)) : x0;

  const fractions = [0, 0.25, 0.5, 0.75, 1];
  const gridX = xTicks ?? fractions.map(f => x0 + f * (x1 - x0));
  const inView = (x: number) => x >= x0 - 1e-6 && x <= x1 + 1e-6;
  const fmtX = (v: number) => (Math.abs(v) >= 10 || Number.isInteger(v) ? v.toFixed(0) : v.toFixed(2));
  const tick = { className: 'fill-current text-dim', style: { fontSize: 9 } };
  return (
    <div className='flex flex-col gap-2'>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className='w-full cursor-crosshair select-none rounded bg-surface-raised'
           onPointerDown={onPointerDown} onDoubleClick={onDoubleClick}>
        {gridX.filter(inView).map(t => (
          <line key={`x${t}`} x1={px(t)} x2={px(t)} y1={PAD.top} y2={PAD.top + PH} stroke='currentColor' className='text-border' strokeOpacity={0.6} />
        ))}
        {fractions.map(f => {
          const v = lo + f * (hi - lo);
          return (
            <g key={`y${f}`}>
              <line x1={PAD.left} x2={PAD.left + PW} y1={py(v)} y2={py(v)} stroke='currentColor' className='text-border' strokeOpacity={0.6} />
              <text x={PAD.left - 4} y={py(v) + 3} textAnchor='end' {...tick}>
                {Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2)}
              </text>
            </g>
          );
        })}
        {zeroLine && lo < 0 && hi > 0 && (
          <line x1={PAD.left} x2={PAD.left + PW} y1={py(0)} y2={py(0)} stroke='currentColor' className='text-muted' strokeOpacity={0.9} />
        )}
        {xTicks
          ? xTicks.filter(inView).map(t => <text key={`xl${t}`} x={px(t)} y={H - 4} textAnchor='middle' {...tick}>{fmtX(t)}</text>)
          : <>
              <text x={PAD.left} y={H - 4} {...tick}>{fmtX(x0)}</text>
              <text x={PAD.left + PW} y={H - 4} textAnchor='end' {...tick}>{fmtX(x1)}</text>
            </>}
        {yLabel && <text x={PAD.left + 3} y={PAD.top + 9} {...tick}>{yLabel}</text>}
        {xLabel && <text x={PAD.left + PW - 3} y={PAD.top + PH - 4} textAnchor='end' {...tick}>{xLabel}</text>}
        {marker && inView(marker.x) && (
          <g className='text-warning'>
            <line x1={px(marker.x)} x2={px(marker.x)} y1={PAD.top} y2={PAD.top + PH} stroke='currentColor' strokeDasharray='3 2' />
            <text x={px(marker.x) + 3} y={PAD.top + 20} className='fill-current' style={{ fontSize: 9 }}>{marker.label}</text>
          </g>
        )}
        {linear ? <>
          {/* Held flat past the end keys: dashed, since nothing there is authored. */}
          {(!keys.length || first > x0) && (
            <path d={line(x0, keys.length ? first : x1)} fill='none' stroke='currentColor' strokeWidth={2} strokeDasharray='4 3' className='text-primary' strokeOpacity={0.6} />
          )}
          {keys.length > 0 && <path d={line(first, last)} fill='none' stroke='currentColor' strokeWidth={2} className='text-primary' />}
          {keys.length > 0 && last < x1 && (
            <path d={line(last, x1)} fill='none' stroke='currentColor' strokeWidth={2} strokeDasharray='4 3' className='text-primary' strokeOpacity={0.6} />
          )}
        </> : (
          <path d={evaluate ? line(x0, x1) : pathOf(curve, PW, PH, lo, hi, PAD.left, PAD.top)} fill='none' stroke='currentColor' strokeWidth={2} className='text-primary' />
        )}
        {keys.map((k, i) => (
          <circle key={i} cx={px(k.t)} cy={py(k.v)} r={selected === i ? 5.5 : 4.5}
                  className={cn('fill-current cursor-grab', selected === i ? 'text-fg' : 'text-primary')}
                  stroke='currentColor' strokeOpacity={0.6} />
        ))}
      </svg>
      <div className='text-ui-xs text-dim'>Drag keys · double-click empty space to add · double-click a key to remove</div>
      {sel && (
        <div className='flex items-center gap-1 text-ui-sm text-muted'>
          <span>{keyLabels[0]}</span>
          <NumberInput value={sel.t} min={x0} max={x1} step={snap?.x ?? 0.01} onChange={t => setSel({ t: Math.min(x1, Math.max(x0, t)) })} />
          <span>{keyLabels[1]}</span>
          <NumberInput value={sel.v} step={snap?.y ?? 0.05} onChange={v => setSel({ v })} />
          {!linear && <>
            <Button size='sm' variant='subtle' title='Let the curve pass through smoothly'
                    onClick={() => setSel({ inTangent: undefined, outTangent: undefined })}>Auto</Button>
            <Button size='sm' variant='subtle' title='Flat tangents: the curve eases into and out of this key'
                    onClick={() => setSel({ inTangent: 0, outTangent: 0 })}>Flat</Button>
          </>}
        </div>
      )}
      {presets.length > 0 && (
        <div className='flex flex-wrap gap-1'>
          {presets.map(p => (
            <Button key={p.label} size='sm' variant='subtle'
                    onClick={() => {
                      // Presets are shapes over 0..1; scale them into the authored range.
                      const span = max - min;
                      onChange(p.curve.keys.map(k => ({ ...k, v: min + k.v * span })));
                      setSelected(null);
                    }}>{p.label}</Button>
          ))}
        </div>
      )}
    </div>
  );
}

export default CurveInput;

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

/** The y range the plot shows: the authored range, grown to fit every key with a little headroom. */
function viewRange(curve: Curve, min: number, max: number): [number, number] {
  let lo = min, hi = max;
  for (const k of curve.keys) { lo = Math.min(lo, k.v); hi = Math.max(hi, k.v); }
  if (hi - lo < 1e-3) hi = lo + 1;
  return [lo, hi];
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
  const svgRef = useRef<SVGSVGElement>(null);
  const [selected, setSelected] = useState<number | null>(null);
  // Frozen while dragging, so the view does not rescale under the cursor and run away with the key.
  const [frozen, setFrozen] = useState<[number, number] | null>(null);
  const [lo, hi] = frozen ?? viewRange(value, min, max);

  const px = (t: number) => PAD.left + t * PW;
  const py = (v: number) => PAD.top + PH - ((v - lo) / (hi - lo)) * PH;
  const toT = (x: number) => Math.min(1, Math.max(0, (x - PAD.left) / PW));
  const toV = (y: number) => lo + (1 - (y - PAD.top) / PH) * (hi - lo);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };

  const write = (keys: CurveKey[]) => onChange({ keys: [...keys].sort((a, b) => a.t - b.t) });

  const keyAt = (x: number, y: number) =>
    value.keys.findIndex(k => Math.hypot(px(k.t) - x, py(k.v) - y) < 7);

  const startDrag = (index: number) => {
    setSelected(index);
    setFrozen([lo, hi]);
    const keys = value.keys.map(k => ({ ...k }));
    const dragged = keys[index];
    const move = (e: PointerEvent) => {
      const p = local(e);
      dragged.t = +toT(p.x).toFixed(3);
      dragged.v = +toV(p.y).toFixed(3);
      const sorted = [...keys].sort((a, b) => a.t - b.t);
      setSelected(sorted.indexOf(dragged));
      write(keys);
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
      if (value.keys.length <= 1) return;
      write(value.keys.filter((_, j) => j !== i));
      setSelected(null);
      return;
    }
    const t = toT(p.x);
    write([...value.keys, { t: +t.toFixed(3), v: +toV(p.y).toFixed(3) }]);
  };

  const sel = selected !== null ? value.keys[selected] : undefined;
  const setSel = (patch: Partial<CurveKey>) => {
    if (selected === null) return;
    write(value.keys.map((k, i) => (i === selected ? { ...k, ...patch } : k)));
  };

  const grid = [0, 0.25, 0.5, 0.75, 1];
  return (
    <div className='flex flex-col gap-2'>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className='w-full cursor-crosshair select-none rounded bg-surface-raised'
           onPointerDown={onPointerDown} onDoubleClick={onDoubleClick}>
        {grid.map(t => (
          <line key={`x${t}`} x1={px(t)} x2={px(t)} y1={PAD.top} y2={PAD.top + PH} stroke='currentColor' className='text-border' strokeOpacity={0.6} />
        ))}
        {grid.map(f => {
          const v = lo + f * (hi - lo);
          return (
            <g key={`y${f}`}>
              <line x1={PAD.left} x2={PAD.left + PW} y1={py(v)} y2={py(v)} stroke='currentColor' className='text-border' strokeOpacity={0.6} />
              <text x={PAD.left - 4} y={py(v) + 3} textAnchor='end' className='fill-current text-dim' style={{ fontSize: 9 }}>
                {Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2)}
              </text>
            </g>
          );
        })}
        <text x={PAD.left} y={H - 4} className='fill-current text-dim' style={{ fontSize: 9 }}>0</text>
        <text x={PAD.left + PW} y={H - 4} textAnchor='end' className='fill-current text-dim' style={{ fontSize: 9 }}>1</text>
        <path d={pathOf(value, PW, PH, lo, hi, PAD.left, PAD.top)} fill='none' stroke='currentColor' strokeWidth={2} className='text-primary' />
        {value.keys.map((k, i) => (
          <circle key={i} cx={px(k.t)} cy={py(k.v)} r={selected === i ? 5.5 : 4.5}
                  className={cn('fill-current cursor-grab', selected === i ? 'text-fg' : 'text-primary')}
                  stroke='currentColor' strokeOpacity={0.6} />
        ))}
      </svg>
      <div className='text-ui-xs text-dim'>Drag keys · double-click empty space to add · double-click a key to remove</div>
      {sel && (
        <div className='flex items-center gap-1 text-ui-sm text-muted'>
          <span>t</span>
          <NumberInput value={sel.t} min={0} max={1} step={0.01} onChange={t => setSel({ t: Math.min(1, Math.max(0, t)) })} />
          <span>v</span>
          <NumberInput value={sel.v} step={0.05} onChange={v => setSel({ v })} />
          <Button size='sm' variant='subtle' title='Let the curve pass through smoothly'
                  onClick={() => setSel({ inTangent: undefined, outTangent: undefined })}>Auto</Button>
          <Button size='sm' variant='subtle' title='Flat tangents: the curve eases into and out of this key'
                  onClick={() => setSel({ inTangent: 0, outTangent: 0 })}>Flat</Button>
        </div>
      )}
      <div className='flex flex-wrap gap-1'>
        {PRESETS.map(p => (
          <Button key={p.label} size='sm' variant='subtle'
                  onClick={() => {
                    // Presets are shapes over 0..1; scale them into the authored range.
                    const span = max - min;
                    onChange({ keys: p.curve.keys.map(k => ({ ...k, v: min + k.v * span })) });
                    setSelected(null);
                  }}>{p.label}</Button>
        ))}
      </div>
    </div>
  );
}

export default CurveInput;

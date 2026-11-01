import { useRef, useState } from 'react';
import { CurveGraph, Slider } from '@cleo/app-kit/ui';
import { evalBlend, type BlendCurve } from '../blendCurve';

// The selected blend's curve, large and editable: x is the share of the gap between two keys, y the share
// of the way from the previous pose (0) to the arriving one (1). Each curve type edits its own way --
// a bezier by its two handles, a spring by its frequency and damping, a free-form curve key by key (the
// app-kit CurveGraph the particle curves use).

const W = 280, H = 180;
const PAD = { left: 10, right: 10, top: 14, bottom: 14 };
const Y_LO = -0.5, Y_HI = 1.5;
const PW = W - PAD.left - PAD.right, PH = H - PAD.top - PAD.bottom;
const px = (x: number) => PAD.left + x * PW;
const py = (y: number) => PAD.top + (1 - (y - Y_LO) / (Y_HI - Y_LO)) * PH;

/** The curve as an SVG path over a box: x 0..w from `x0`, y mapped by `toY`. */
export function blendPath(curve: BlendCurve, x0: number, w: number, toY: (v: number) => number, samples = 64): string {
  // A hold is a step: flat, then the snap as a vertical edge.
  if (curve.type === 'hold') return `M${x0},${toY(0)} L${x0 + w},${toY(0)} L${x0 + w},${toY(1)}`;
  let d = '';
  for (let i = 0; i <= samples; i++) {
    const u = i / samples;
    d += `${i ? ' L' : 'M'}${(x0 + u * w).toFixed(2)},${toY(evalBlend(curve, u)).toFixed(2)}`;
  }
  return d;
}

export function BlendCurveEditor({ curve, onChange, marker }: {
  curve: BlendCurve;
  onChange: (c: BlendCurve) => void;
  /** Where the playhead is across this blend (0..1), when it is inside it. */
  marker?: number;
}) {
  if (curve.type === 'keys') {
    return (
      <CurveGraph keys={curve.keys} onChange={keys => onChange({ type: 'keys', keys })} min={Y_LO} max={Y_HI}
                  xLabel='blend' yLabel='pose' presets={[]} keyLabels={['u', 'pose']}
                  marker={marker !== undefined ? { x: marker, label: 'now' } : undefined} />
    );
  }
  return (
    <div className='flex flex-col gap-1'>
      <Graph curve={curve} onChange={onChange} marker={marker} />
      {curve.type === 'spring' && (<>
        <Slider label='Swings' min={0.25} max={8} step={0.05} readout value={curve.frequency}
                onChange={v => onChange({ ...curve, frequency: v })} />
        <Slider label='Damping' min={0.02} max={0.99} step={0.01} readout value={curve.damping}
                onChange={v => onChange({ ...curve, damping: v })} />
      </>)}
      <div className='text-ui-xs text-dim'>
        {curve.type === 'bezier' ? 'Drag the two handles · above the top line overshoots the pose, below the bottom one winds up'
          : curve.type === 'spring' ? 'A spring released at the previous pose, settling on the arriving one'
          : 'Holds the previous pose, then snaps at the key'}
      </div>
    </div>
  );
}

function Graph({ curve, onChange, marker }: { curve: BlendCurve; onChange: (c: BlendCurve) => void; marker?: number }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<0 | 1 | null>(null);
  const toCurve = (e: React.PointerEvent): [number, number] => {
    const r = svgRef.current!.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width * W - PAD.left) / PW;
    const y = Y_LO + (1 - ((e.clientY - r.top) / r.height * H - PAD.top) / PH) * (Y_HI - Y_LO);
    const round = (v: number) => Math.round(v * 1000) / 1000;
    return [round(Math.min(1, Math.max(0, x))), round(Math.min(2, Math.max(-1, y)))];
  };
  const move = (e: React.PointerEvent) => {
    if (drag === null || curve.type !== 'bezier') return;
    const [x, y] = toCurve(e);
    const p: [number, number, number, number] = [...curve.p];
    p[drag * 2] = x; p[drag * 2 + 1] = y;
    onChange({ type: 'bezier', p });
  };
  return (
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className='w-full select-none rounded bg-surface-raised'
         onPointerMove={move} onPointerUp={() => setDrag(null)} onPointerLeave={() => setDrag(null)}>
      {[0.25, 0.5, 0.75].map(x => <line key={x} x1={px(x)} x2={px(x)} y1={PAD.top} y2={PAD.top + PH} stroke='currentColor' className='text-border' strokeOpacity={0.5} />)}
      {[0, 1].map(y => <line key={y} x1={PAD.left} x2={PAD.left + PW} y1={py(y)} y2={py(y)} stroke='currentColor' className='text-muted' strokeOpacity={0.8} />)}
      <text x={PAD.left + 2} y={py(1) - 3} className='fill-current text-dim' style={{ fontSize: 9 }}>next pose</text>
      <text x={PAD.left + 2} y={py(0) + 10} className='fill-current text-dim' style={{ fontSize: 9 }}>previous pose</text>
      {marker !== undefined && (
        <line x1={px(marker)} x2={px(marker)} y1={PAD.top} y2={PAD.top + PH} stroke='currentColor' className='text-warning' strokeDasharray='3 2' />
      )}
      <path d={blendPath(curve, PAD.left, PW, py)} fill='none' stroke='currentColor' strokeWidth={2} className='text-primary' />
      {curve.type === 'bezier' && ([0, 1] as const).map(i => {
        const [hx, hy] = [curve.p[i * 2], curve.p[i * 2 + 1]];
        const [ax, ay] = i === 0 ? [0, 0] : [1, 1];
        return (
          <g key={i} className='text-fg'>
            <line x1={px(ax)} y1={py(ay)} x2={px(hx)} y2={py(hy)} stroke='currentColor' strokeOpacity={0.5} />
            <circle cx={px(hx)} cy={py(hy)} r={6} className='fill-current cursor-grab' fillOpacity={drag === i ? 1 : 0.8}
                    onPointerDown={e => { (e.target as Element).setPointerCapture?.(e.pointerId); setDrag(i); }} />
          </g>
        );
      })}
    </svg>
  );
}

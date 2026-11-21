import { useMemo } from 'react';
import { timelineTimeOf, type MotionReference } from '../reference/referenceDoc';
import type { AnalysisView } from '../reference/cv/analysisView';

// The Timeline's Analysis lane, under the Video lane once the clip is analysed: the subject's motion energy
// (how much it changes frame to frame) as a curve, the key-pose candidates where it dips (click one to go
// there), long holds shaded, and cuts as red lines.

export const ANALYSIS_LANE_H = 34;

export interface AnalysisLaneProps {
  reference: MotionReference;
  times: Float64Array;
  /** The analysis (absent: only the tracks' marks). */
  view: AnalysisView | null;
  /** Tracked feet planted (timeline seconds) and hands or head turning, in their tracks' colours. */
  contacts?: { t0: number; t1: number; color: string; label: string }[];
  turns?: { t: number; color: string; label: string }[];
  x: (t: number) => number;
  width: number;
  onSeek: (t: number) => void;
}

export function AnalysisLane({ reference, times, view, contacts = [], turns = [], x, width, onSeek }: AnalysisLaneProps) {
  const H = ANALYSIS_LANE_H;
  const inside = (v: number) => v >= reference.in - 1e-6 && v <= reference.out + 1e-6;
  const at = (i: number) => x(timelineTimeOf(reference, times[i]));
  const { path, scale } = useMemo(() => {
    if (!view) return { path: '', scale: (_: number) => H / 2 };
    const vals = Array.from(view.curve).filter(Number.isFinite).sort((a, b) => a - b);
    const top = vals[Math.floor(vals.length * 0.98)] || 1e-6;
    const y = (v: number) => H - 3 - Math.min(1, v / top) * (H - 8);
    let d = '';
    for (let i = 0; i < times.length; i++) {
      if (!inside(times[i])) continue;
      d += `${d ? 'L' : 'M'}${at(i).toFixed(1)} ${y(view.curve[i]).toFixed(1)}`;
    }
    return { path: d, scale: y };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, times, reference.in, reference.out, reference.offset, reference.speed, x]);
  // Holds of three frames or more (a freeze, a pause in the action), as runs.
  const holds = useMemo(() => {
    const out: [number, number][] = [];
    if (!view) return out;
    for (let i = 1; i < view.held.length; i++) {
      if (!view.held[i]) continue;
      let j = i; while (j + 1 < view.held.length && view.held[j + 1]) j++;
      if (j - i + 2 >= 3) out.push([i - 1, j]);
      i = j;
    }
    return out;
  }, [view]);
  return (
    <svg className='absolute left-0 top-0' width={width} height={H}>
      {holds.filter(([a]) => inside(times[a])).map(([a, b]) => (
        <rect key={a} x={at(a)} y={0} width={Math.max(1, at(b) - at(a))} height={H} className='fill-current text-surface-raised' fillOpacity={0.8}>
          <title>Held frames: the picture does not change</title>
        </rect>
      ))}
      {contacts.map((c, k) => (
        <rect key={`p${k}`} x={x(c.t0)} y={H - 5} width={Math.max(2, x(c.t1) - x(c.t0))} height={4} rx={1} fill={c.color} fillOpacity={0.85}>
          <title>{`${c.label} planted`}</title>
        </rect>
      ))}
      <path d={path} fill='none' className='stroke-current text-primary' strokeWidth={1.25} />
      {turns.map((t, k) => (
        <g key={`t${k}`} className='cursor-pointer' onPointerDown={e => { e.stopPropagation(); onSeek(t.t); }}>
          <title>{`${t.label} turns here · click to go there`}</title>
          <circle cx={x(t.t)} cy={4} r={3} fill={t.color} />
        </g>
      ))}
      {view && view.cuts.filter(i => inside(times[i])).map(i => (
        <line key={`c${i}`} x1={at(i)} x2={at(i)} y1={0} y2={H} className='stroke-current text-danger-fg' strokeWidth={1.5}>
          <title>A cut: the shot changes here</title>
        </line>
      ))}
      {view && view.candidates.filter(c => inside(times[c.frame])).map(c => {
        const cx = at(c.frame), cy = scale(view.curve[c.frame]);
        return (
          <g key={`k${c.frame}`} className='cursor-pointer' onPointerDown={e => { e.stopPropagation(); onSeek(timelineTimeOf(reference, times[c.frame])); }}>
            <title>{`A key pose? Frame ${c.frame + 1}: the motion dips here (${Math.round(c.prominence * 100)}%) · click to go there`}</title>
            <path d={`M${cx} ${cy + 1}l-5 -8h10z`} className='fill-current text-warning' />
            <rect x={cx - 6} y={0} width={12} height={H} fill='transparent' />
          </g>
        );
      })}
    </svg>
  );
}

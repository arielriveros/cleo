import { useEffect, useRef, useState } from 'react';
import { videoToView, viewToVideo, type Rect } from '../reference/gate';
import type { ReferencePlayer, ShownFrame } from '../reference/referencePlayer';
import { frameIndexAt } from '../reference/referenceDoc';
import { roleOf, type TracksState } from '../reference/tracks';
import type { Extremity } from '../reference/cv/silhouette';

// Reference ▸ Tracking, over the video: each track's point on the frame shown (its role's colour, hollow on a
// seed frame), with a short trail of where it was and will be, and suggestions from the silhouette. Drag a
// point to correct it on this frame (a new seed); in placing mode, click to start a track there.
//
// Marked `data-cleo-overlay` so posing and orbiting ignore its handles.

export interface TrackOverlayProps {
  gate: Rect;
  videoW: number;
  videoH: number;
  player: ReferencePlayer | null;
  /** Every frame's video time (the seeds' frame numbers index these). */
  timestamps: Float64Array;
  state: TracksState;
  /** A role waiting for a click to start a track. */
  placing: boolean;
  suggestions: Extremity[];
  onPlace: (frame: number, x: number, y: number) => void;
  onSeed: (trackId: string, frame: number, x: number, y: number) => void;
  /** The frame on screen changed (for the panel's readouts). */
  onFrame?: (frame: number) => void;
}

const TRAIL = 12;

export function TrackOverlay({ gate, videoW, videoH, player, timestamps, state, placing, suggestions, onPlace, onSeed, onFrame }: TrackOverlayProps) {
  const root = useRef<SVGSVGElement>(null);
  const [frame, setFrame] = useState(-1);
  useEffect(() => {
    if (!player) return;
    const at = (f: ShownFrame | null) => setFrame(f ? frameIndexAt(timestamps, f.timestamp) : -1);
    at(player.current);
    return player.subscribe(at);
  }, [player, timestamps]);
  const reportFrame = useRef(onFrame);
  reportFrame.current = onFrame;
  useEffect(() => { reportFrame.current?.(frame); }, [frame]);

  const toView = (x: number, y: number) => videoToView([x * videoW, y * videoH], gate, videoW, videoH);
  const toUnit = (clientX: number, clientY: number): [number, number] => {
    const r = root.current!.getBoundingClientRect();
    const v = viewToVideo([clientX - r.left, clientY - r.top], gate, videoW, videoH);
    return [Math.min(1, Math.max(0, v[0] / videoW)), Math.min(1, Math.max(0, v[1] / videoH))];
  };
  const pointAt = (id: string, i: number): [number, number] | null => {
    const seed = state.tracks.find(t => t.id === id)?.seeds.find(s => s.frame === i);
    if (seed) return [seed.x, seed.y];
    const pts = state.result?.points[id];
    if (!pts || i < 0 || i * 2 + 1 >= pts.length) return null;
    const x = pts[i * 2], y = pts[i * 2 + 1];
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
  };

  const drag = (e: React.PointerEvent, id: string) => {
    e.stopPropagation(); e.preventDefault();
    const f = frame;
    const move = (ev: PointerEvent) => { const [x, y] = toUnit(ev.clientX, ev.clientY); onSeed(id, f, x, y); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <svg ref={root} data-cleo-overlay className='pointer-events-none absolute inset-0 h-full w-full overflow-visible'>
      {placing && frame >= 0 && (
        <rect x={gate.x} y={gate.y} width={gate.w} height={gate.h} fill='transparent' className='cursor-crosshair' style={{ pointerEvents: 'all' }}
              onPointerDown={e => { e.stopPropagation(); e.preventDefault(); const [x, y] = toUnit(e.clientX, e.clientY); onPlace(frame, x, y); }}>
          <title>Click the point to track on this frame</title>
        </rect>
      )}
      {state.tracks.map(t => {
        const color = roleOf(t.role).color;
        // The trail, broken where the point was lost.
        let d = '', pen = false;
        for (let i = Math.max(0, frame - TRAIL); i <= frame + TRAIL; i++) {
          const p = pointAt(t.id, i);
          if (!p) { pen = false; continue; }
          const [vx, vy] = toView(p[0], p[1]);
          d += `${pen ? 'L' : 'M'}${vx.toFixed(1)} ${vy.toFixed(1)}`;
          pen = true;
        }
        const now = pointAt(t.id, frame);
        const isSeed = t.seeds.some(s => s.frame === frame);
        const [cx, cy] = now ? toView(now[0], now[1]) : [0, 0];
        return (
          <g key={t.id}>
            {d && <path d={d} fill='none' stroke={color} strokeOpacity={0.55} strokeWidth={1.5} />}
            {now && (<>
              <circle cx={cx} cy={cy} r={7} fill={isSeed ? 'transparent' : color} fillOpacity={0.35} stroke={color} strokeWidth={2}
                      className='cursor-move' style={{ pointerEvents: 'all' }} onPointerDown={e => drag(e, t.id)}>
                <title>{`${roleOf(t.role).label}: drag to put it right on this frame`}</title>
              </circle>
              <text x={cx + 9} y={cy - 7} fill={color} style={{ fontSize: 10, paintOrder: 'stroke', stroke: 'black', strokeWidth: 3 }}>{roleOf(t.role).label}</text>
            </>)}
          </g>
        );
      })}
      {suggestions.map((s, i) => {
        const [x, y] = toView(s.x, s.y);
        return (
          <g key={`s${i}`} style={{ pointerEvents: 'all' }} className='cursor-pointer'
             onPointerDown={e => { e.stopPropagation(); e.preventDefault(); if (frame >= 0) onPlace(frame, s.x, s.y); }}>
            <circle cx={x} cy={y} r={6} fill='none' stroke='#ffe066' strokeWidth={2} strokeDasharray='3 2' />
            <title>A furthest point of the subject’s outline: click to track it</title>
          </g>
        );
      })}
    </svg>
  );
}

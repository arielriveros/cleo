import { useRef } from 'react';
import type { CalibrationDoc, Segment, Solve } from '../reference/calibrate';
import { videoToView, viewToVideo, type Rect } from '../reference/gate';
import type { Vec2 } from '../reference/referenceCamera';

// Reference ▸ Calibrate, drawn over the video: lines to lay along the filmed ground's two axes (X red, Z
// blue), dashed on to where each pair meets (its vanishing point), the horizon they give, the subject's
// ground point (the world's origin) and the top of its head (or a ruler of known length on the ground), and
// Match pose's pins with the character's joints as the solved camera sees them. Every handle drags; the
// camera is solved live while dragging and written when a drag ends.
//
// Marked `data-cleo-overlay`: the handles are not the viewport's, so posing and orbiting ignore them, and
// everywhere else the pointer passes through to the 3D view.

export interface CalibrationOverlayProps {
  gate: Rect;
  videoW: number;
  videoH: number;
  calib: CalibrationDoc;
  solve: Solve | null;
  /** Which handles show: the lines and the origin (and scale), or the pins. */
  show: { lines: boolean; pins: boolean };
  /** Joints as the current camera projects them (video pixels), for the pins' error lines. */
  projected?: Map<string, Vec2>;
  /** A joint waiting for a click on the frame to pin it there. */
  placing?: string | null;
  onPlace?: (at: Vec2) => void;
  onChange: (next: CalibrationDoc, done: boolean) => void;
}

const X_COLOR = '#e06060', Z_COLOR = '#5b8fe6', HORIZON = '#e8c547', PIN = '#f2994a', SCALE = '#6fcf7f';

export function CalibrationOverlay({ gate, videoW, videoH, calib, solve, show, projected, placing, onPlace, onChange }: CalibrationOverlayProps) {
  const root = useRef<SVGSVGElement>(null);
  const toView = (p: Vec2) => videoToView(p, gate, videoW, videoH);
  const toVideo = (clientX: number, clientY: number): Vec2 => {
    const r = root.current!.getBoundingClientRect();
    return viewToVideo([clientX - r.left, clientY - r.top], gate, videoW, videoH);
  };

  /** Drag a handle: `apply` makes the next document from the pointer's video pixel. */
  const drag = (e: React.PointerEvent, apply: (at: Vec2, from: CalibrationDoc) => CalibrationDoc) => {
    e.stopPropagation();
    e.preventDefault();
    const from = structuredClone(calib);
    let last = from;
    const move = (ev: PointerEvent) => { last = apply(toVideo(ev.clientX, ev.clientY), from); onChange(last, false); };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      onChange(last, true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const handle = (p: Vec2, color: string, title: string, apply: (at: Vec2, from: CalibrationDoc) => CalibrationDoc, r = 6) => {
    const [x, y] = toView(p);
    return (
      <circle cx={x} cy={y} r={r} fill={color} fillOpacity={0.35} stroke={color} strokeWidth={2} className='cursor-move'
              style={{ pointerEvents: 'all' }} onPointerDown={e => drag(e, apply)}>
        <title>{title}</title>
      </circle>
    );
  };

  /** A line with its two end handles, dashed on to its vanishing point when there is one. */
  const line = (axis: 'x' | 'z', i: 0 | 1) => {
    const s = calib[axis][i];
    const color = axis === 'x' ? X_COLOR : Z_COLOR;
    const [a, b] = [toView(s[0]), toView(s[1])];
    const vp = solve?.vanishing[axis];
    const set = (end: 0 | 1) => (at: Vec2, from: CalibrationDoc): CalibrationDoc => {
      const pair = from[axis].map(x => [...x]) as [Segment, Segment];
      pair[i][end] = at;
      return { ...from, [axis]: pair };
    };
    let toVp: React.ReactNode = null;
    if (vp) {
      const v = toView(vp);
      const near = Math.hypot(v[0] - a[0], v[1] - a[1]) < Math.hypot(v[0] - b[0], v[1] - b[1]) ? a : b;
      toVp = <line x1={near[0]} y1={near[1]} x2={v[0]} y2={v[1]} stroke={color} strokeOpacity={0.5} strokeDasharray='4 4' />;
    }
    const used = axis === 'z' || calib.mode === '2vp' || i === 0;
    return (
      <g key={`${axis}${i}`} opacity={used ? 1 : 0.3}>
        {toVp}
        <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={color} strokeWidth={2} />
        {handle(s[0], color, `${axis.toUpperCase()} line: lay it along the ground’s ${axis.toUpperCase()} axis`, set(0))}
        {handle(s[1], color, `${axis.toUpperCase()} line: lay it along the ground’s ${axis.toUpperCase()} axis`, set(1))}
      </g>
    );
  };

  const origin = toView(calib.origin), head = toView(calib.head);
  const horizon = solve?.horizon;
  return (
    <svg ref={root} data-cleo-overlay className='pointer-events-none absolute inset-0 h-full w-full overflow-visible'>
      {placing && (
        <rect x={gate.x} y={gate.y} width={gate.w} height={gate.h} fill='transparent' className='cursor-crosshair' style={{ pointerEvents: 'all' }}
              onPointerDown={e => { e.stopPropagation(); e.preventDefault(); onPlace?.(toVideo(e.clientX, e.clientY)); }}>
          <title>{`Click where the ${placing} is in the frame`}</title>
        </rect>
      )}
      {show.lines && (<>
        {horizon && (() => { const [a, b] = [toView(horizon[0]), toView(horizon[1])]; return <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={HORIZON} strokeDasharray='8 5' strokeOpacity={0.8} />; })()}
        {line('x', 0)}{line('x', 1)}{line('z', 0)}{line('z', 1)}
        {calib.scale === 'subject' ? (<>
          <line x1={origin[0]} y1={origin[1]} x2={head[0]} y2={head[1]} stroke={SCALE} strokeDasharray='3 3' />
          {handle(calib.head, SCALE, 'The top of the subject’s head, straight above its feet: its height sets the scale', (at, f) => ({ ...f, head: at }), 5)}
        </>) : (() => {
          const [a, b] = [toView(calib.ruler.a), toView(calib.ruler.b)];
          return (<>
            <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={SCALE} strokeWidth={2} />
            {handle(calib.ruler.a, SCALE, 'A ruler on the ground: its ends a known distance apart', (at, f) => ({ ...f, ruler: { ...f.ruler, a: at } }), 5)}
            {handle(calib.ruler.b, SCALE, 'A ruler on the ground: its ends a known distance apart', (at, f) => ({ ...f, ruler: { ...f.ruler, b: at } }), 5)}
          </>);
        })()}
        <g>
          <line x1={origin[0] - 10} y1={origin[1]} x2={origin[0] + 10} y2={origin[1]} stroke='white' strokeWidth={2} />
          <line x1={origin[0]} y1={origin[1] - 10} x2={origin[0]} y2={origin[1] + 10} stroke='white' strokeWidth={2} />
          {handle(calib.origin, '#ffffff', 'The subject’s ground point: the world’s origin, where the character stands', (at, f) => ({ ...f, origin: at }), 7)}
        </g>
      </>)}
      {show.pins && calib.pins.map((p, i) => {
        const [x, y] = toView(p.at);
        const proj = projected?.get(p.joint);
        const q = proj ? toView(proj) : null;
        return (
          <g key={`${p.joint}${i}`}>
            {q && <line x1={x} y1={y} x2={q[0]} y2={q[1]} stroke={PIN} strokeOpacity={0.7} />}
            {q && <circle cx={q[0]} cy={q[1]} r={3} fill='none' stroke={PIN} />}
            {handle(p.at, PIN, `${p.joint}: where it is in the frame`, (at, f) => ({ ...f, pins: f.pins.map((x, j) => (j === i ? { ...x, at } : x)) }), 5)}
            <text x={x + 8} y={y - 6} fill={PIN} style={{ fontSize: 10, paintOrder: 'stroke', stroke: 'black', strokeWidth: 3 }}>{p.joint.replace(/^.*[:|]/, '')}</text>
          </g>
        );
      })}
    </svg>
  );
}

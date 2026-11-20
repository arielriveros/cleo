import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReferencePlayer, ShownFrame } from '../reference/referencePlayer';
import { gateRect, type Rect } from '../reference/gate';

// The reference video over the 3D view (the Stage's Over): the frame drawn into a canvas laid on the film
// gate -- the whole video, as large as fits -- at an opacity, optionally as the DIFFERENCE of the two
// pictures (where the character matches the footage it goes dark) and mirrored. Outside the gate the view
// can be darkened. It never takes the pointer: posing, picking and orbiting pass straight through.
//
// Not marked `data-cleo-overlay` on purpose: PoseGizmos treats those as outside the viewport, and this
// covers all of it.

export interface ReferenceOverlayProps {
  player: ReferencePlayer | null;
  /** Shown at all (Over, with a clip). */
  visible: boolean;
  opacity: number;
  difference: boolean;
  flip: boolean;
  gate: boolean;
  /** A region of the video (its unit square) zoomed to fill the view: the subject crop; null: the whole frame. */
  crop?: { x: number; y: number; w: number; h: number } | null;
  /** The gate as it lands in the view, for the other overlays (calibration, tracks). */
  onGate?: (gate: Rect | null) => void;
}

export function ReferenceOverlay({ player, visible, opacity, difference, flip, gate, crop, onGate }: ReferenceOverlayProps) {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [hasFrame, setHasFrame] = useState(false);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Each frame the player shows is drawn at once: the sink reuses its canvases.
  useEffect(() => {
    if (!player) { setHasFrame(false); return; }
    const draw = (f: ShownFrame | null) => {
      const c = canvas.current;
      setHasFrame(!!f);
      if (!c || !f) return;
      if (c.width !== f.width || c.height !== f.height) { c.width = f.width; c.height = f.height; }
      c.getContext('2d')?.drawImage(f.canvas as CanvasImageSource, 0, 0);
    };
    draw(player.current);
    return player.subscribe(draw);
  }, [player]);

  const video = player?.doc;
  const rect = video && size.w > 0 ? gateRect(size.w, size.h, video.width, video.height, crop) : null;
  const report = useRef(onGate);
  report.current = onGate;
  const key = rect ? `${rect.x.toFixed(1)},${rect.y.toFixed(1)},${rect.w.toFixed(1)},${rect.h.toFixed(1)}` : '';
  useEffect(() => { report.current?.(rect); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const show = visible && !!rect;
  return (
    <div ref={root} className='pointer-events-none absolute inset-0 overflow-hidden'>
      <div className='absolute' style={{
        display: show ? undefined : 'none',
        left: rect?.x ?? 0, top: rect?.y ?? 0, width: rect?.w ?? 0, height: rect?.h ?? 0,
        // The film gate: everything outside the frame dimmed by one huge shadow.
        boxShadow: gate ? '0 0 0 100vmax rgba(0, 0, 0, 0.45)' : undefined,
        outline: gate ? '1px solid rgba(255, 255, 255, 0.25)' : undefined,
      }}>
        <canvas ref={canvas} className='h-full w-full' style={{
          opacity: hasFrame ? (difference ? 1 : opacity) : 0,
          mixBlendMode: difference ? 'difference' : 'normal',
          transform: flip ? 'scaleX(-1)' : undefined,
        }} />
      </div>
    </div>
  );
}

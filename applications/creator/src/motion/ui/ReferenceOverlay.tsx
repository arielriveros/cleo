import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReferencePlayer, ShownFrame } from '../reference/referencePlayer';
import { gateRect, type Rect } from '../reference/gate';
import type { Box } from '../reference/cv/image';

// The reference video over the 3D view (the Stage's Over): the frame drawn into a canvas laid on the film
// gate -- the whole video, as large as fits -- at an opacity, optionally as the DIFFERENCE of the two
// pictures (where the character matches the footage it goes dark) and mirrored. Outside the gate the view
// can be darkened. It never takes the pointer: posing, picking and orbiting pass straight through.
//
// Not marked `data-cleo-overlay` on purpose: PoseGizmos treats those as outside the viewport, and this
// covers all of it.

export interface ReferenceOverlayProps {
  player: ReferencePlayer | null;
  /** The picture shown (Over, with a clip). The gate can show without it (Behind draws the picture in the engine). */
  visible: boolean;
  opacity: number;
  difference: boolean;
  flip: boolean;
  gate: boolean;
  /** A region of the video (its unit square) zoomed to fill the view: the subject crop; null: the whole frame. */
  crop?: { x: number; y: number; w: number; h: number } | null;
  /** A crop per frame instead (following the subject), by the frame's video time. Not reported as the gate. */
  cropAt?: ((v: number) => Box | null) | null;
  /** The subject's box to outline, by the frame's video time. */
  boxAt?: ((v: number) => Box | null) | null;
  /** The gate as it lands in the view and the view's size, for the other overlays and the camera. */
  onGate?: (gate: Rect | null, view: { w: number; h: number }) => void;
}

export function ReferenceOverlay({ player, visible, opacity, difference, flip, gate, crop, cropAt, boxAt, onGate }: ReferenceOverlayProps) {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [hasFrame, setHasFrame] = useState(false);
  /** The video time of the frame on screen: what a following crop and the subject box are read at. */
  const [frameTime, setFrameTime] = useState<number | null>(null);
  const perFrame = !!cropAt || !!boxAt;
  const perFrameRef = useRef(perFrame);
  perFrameRef.current = perFrame;
  // Turned on while paused: read the frame already on screen, not only the next one.
  useEffect(() => { if (perFrame) setFrameTime(player?.current?.timestamp ?? null); }, [perFrame, player]);

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
      if (perFrameRef.current) setFrameTime(f?.timestamp ?? null);
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
  useEffect(() => { report.current?.(rect, size); }, [key, size.w, size.h]); // eslint-disable-line react-hooks/exhaustive-deps

  // Following the subject: this frame's crop; the gate reported stays the static one.
  const dynCrop = cropAt && frameTime !== null ? cropAt(frameTime) : null;
  const shown = video && size.w > 0 && dynCrop ? gateRect(size.w, size.h, video.width, video.height, dynCrop) : rect;
  const box = boxAt && frameTime !== null ? boxAt(frameTime) : null;
  const show = (visible || gate) && !!shown;
  return (
    <div ref={root} className='pointer-events-none absolute inset-0 overflow-hidden'>
      <div className='absolute' style={{
        display: show ? undefined : 'none',
        left: shown?.x ?? 0, top: shown?.y ?? 0, width: shown?.w ?? 0, height: shown?.h ?? 0,
        // The film gate: everything outside the frame dimmed by one huge shadow.
        boxShadow: gate ? '0 0 0 100vmax rgba(0, 0, 0, 0.45)' : undefined,
        outline: gate ? '1px solid rgba(255, 255, 255, 0.25)' : undefined,
      }}>
        <canvas ref={canvas} className='h-full w-full' style={{
          opacity: hasFrame && visible ? (difference ? 1 : opacity) : 0,
          mixBlendMode: difference ? 'difference' : 'normal',
          transform: flip ? 'scaleX(-1)' : undefined,
        }} />
        {box && visible && (
          <div className='absolute border-2 border-dashed border-highlight' title='The subject, as the analysis found it'
               style={{ left: `${(flip ? 1 - box.x - box.w : box.x) * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }} />
        )}
      </div>
    </div>
  );
}

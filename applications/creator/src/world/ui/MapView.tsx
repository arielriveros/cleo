import { useEffect, useRef, useState } from 'react';
import { flattenSpline, type Point2 } from '../spline';
import type { WorldLayer } from '../features';
import type { MapPicture } from './mapImage';
import { HAS_CENTER, HAS_POINTS } from './worldSchemas';

export type { MapLayerView } from './mapImage';

/**
 * The top-down map: a picture of the generated world (a hillshade, a mask, a field, the surfaces; see
 * mapImage.ts) with every spline and centre drawn over it. The selected layer's handles drag;
 * double-click adds a spline point after the nearest one, Alt+click removes one.
 */
export function MapView({ picture, layers, selectedId, onChangeLayer }: {
  picture: MapPicture | null;
  layers: readonly WorldLayer[];
  selectedId: string | null;
  onChangeLayer: (id: string, patch: Partial<WorldLayer>) => void;
}) {
  const imageRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [drag, setDrag] = useState<{ id: string; point: number | 'center' } | null>(null);
  const selected = layers.find(l => l.id === selectedId) ?? null;

  // The image layer: redrawn only when the picture changes.
  useEffect(() => {
    const canvas = imageRef.current;
    if (!canvas || !picture) return;
    canvas.width = picture.width; canvas.height = picture.height;
    const ctx = canvas.getContext('2d')!;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(picture.rgba), picture.width, picture.height), 0, 0);
  }, [picture]);

  // The overlay: splines and handles, redrawn on every layer change.
  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    const size = canvas.clientWidth;
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, size, size);
    for (const l of layers) {
      if (!l.enabled) continue;
      const active = l.id === selectedId;
      ctx.strokeStyle = active ? 'rgba(143,143,255,1)' : 'rgba(255,255,255,0.35)';
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = active ? 2 : 1;
      if (HAS_POINTS.has(l.kind) && 'points' in l) {
        const pts = flattenSpline(l.points, 12);
        ctx.beginPath();
        pts.forEach(([x, y], k) => (k ? ctx.lineTo(x * size, y * size) : ctx.moveTo(x * size, y * size)));
        ctx.stroke();
        if (active) for (const [x, y] of l.points) { ctx.beginPath(); ctx.arc(x * size, y * size, 5, 0, Math.PI * 2); ctx.fill(); }
      }
      if (HAS_CENTER.has(l.kind) && 'center' in l) {
        const [x, y] = l.center;
        const r = 'radius' in l ? l.radius * size : 0;
        ctx.beginPath(); ctx.arc(x * size, y * size, r, 0, Math.PI * 2); ctx.stroke();
        if (active) { ctx.beginPath(); ctx.arc(x * size, y * size, 6, 0, Math.PI * 2); ctx.fill(); }
      }
    }
  }, [layers, selectedId]);

  const toMap = (e: React.PointerEvent | React.MouseEvent): Point2 => {
    const rect = overlayRef.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)), Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height))];
  };
  const near = (a: Point2, b: Point2) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.02;

  const onPointerDown = (e: React.PointerEvent) => {
    if (!selected) return;
    const p = toMap(e);
    if ('points' in selected && HAS_POINTS.has(selected.kind)) {
      const k = selected.points.findIndex(q => near(q, p));
      if (k >= 0 && e.altKey && selected.points.length > 2) {
        onChangeLayer(selected.id, { points: selected.points.filter((_, j) => j !== k) } as Partial<WorldLayer>);
        return;
      }
      if (k >= 0) { setDrag({ id: selected.id, point: k }); (e.target as Element).setPointerCapture(e.pointerId); return; }
    }
    if ('center' in selected && HAS_CENTER.has(selected.kind) && near(selected.center, p)) {
      setDrag({ id: selected.id, point: 'center' });
      (e.target as Element).setPointerCapture(e.pointerId);
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag || !selected || drag.id !== selected.id) return;
    const p = toMap(e);
    if (drag.point === 'center') onChangeLayer(drag.id, { center: p } as Partial<WorldLayer>);
    else if ('points' in selected) onChangeLayer(drag.id, { points: selected.points.map((q, j) => (j === drag.point ? p : q)) } as Partial<WorldLayer>);
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    if (!selected || !('points' in selected) || !HAS_POINTS.has(selected.kind)) return;
    const p = toMap(e);
    // Insert after the nearest point, so a click between two points lands between them.
    let best = 0, bestD = Infinity;
    selected.points.forEach((q, j) => { const d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < bestD) { bestD = d; best = j; } });
    const pts = [...selected.points];
    pts.splice(best + 1, 0, p);
    onChangeLayer(selected.id, { points: pts } as Partial<WorldLayer>);
  };

  return (
    <div className='relative h-full w-full flex items-center justify-center bg-surface-sunken overflow-hidden'>
      <div className='relative aspect-square h-full max-w-full'>
        <canvas ref={imageRef} className='absolute inset-0 h-full w-full' style={{ imageRendering: 'pixelated' }} />
        <canvas ref={overlayRef} className='absolute inset-0 h-full w-full cursor-crosshair'
                onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={() => setDrag(null)} onDoubleClick={onDoubleClick} />
        {!picture && <div className='absolute inset-0 flex items-center justify-center text-dim'>Generating…</div>}
      </div>
    </div>
  );
}

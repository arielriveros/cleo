import { useEffect, useRef, useState } from 'react';
import { flattenSpline, type Point2 } from '../spline';
import type { WorldLayer } from '../features';
import type { MaskKind } from '../masks';
import type { WorldOutput } from '../generateWorld';
import { HAS_CENTER, HAS_POINTS } from './worldSchemas';

export type MapLayerView = 'height' | MaskKind;

/**
 * The top-down map: the generated heights as a hillshade (or one of the masks), with every spline and
 * centre drawn over it. The selected layer's handles drag; double-click adds a spline point after the
 * nearest one, Alt+click removes one.
 */
export function MapView({ output, view, layers, selectedId, onChangeLayer, seaLevel }: {
  output: WorldOutput | null;
  view: MapLayerView;
  layers: readonly WorldLayer[];
  selectedId: string | null;
  onChangeLayer: (id: string, patch: Partial<WorldLayer>) => void;
  seaLevel: number;
}) {
  const imageRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [drag, setDrag] = useState<{ id: string; point: number | 'center' } | null>(null);
  const selected = layers.find(l => l.id === selectedId) ?? null;

  // The image layer: redrawn only when the output or the view changes.
  useEffect(() => {
    const canvas = imageRef.current;
    if (!canvas || !output) return;
    const res = output.frame.resolution;
    canvas.width = res; canvas.height = res;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(res, res);
    const h = output.heights;
    let min = Infinity, max = -Infinity;
    for (const v of h) { if (v < min) min = v; if (v > max) max = v; }
    const span = max - min || 1;
    const shade = view === 'height';
    // Hillshade light from the north-west, the cartographic convention.
    const e = output.frame.size / (res - 1);
    for (let r = 0; r < res; r++) for (let c = 0; c < res; c++) {
      const i = r * res + c;
      let rgb: [number, number, number];
      if (shade) {
        const hx = (h[r * res + Math.min(res - 1, c + 1)] - h[r * res + Math.max(0, c - 1)]) * output.frame.heightScale / (2 * e);
        const hy = (h[Math.min(res - 1, r + 1) * res + c] - h[Math.max(0, r - 1) * res + c]) * output.frame.heightScale / (2 * e);
        const lambert = Math.max(0, (hx * 0.6 + hy * 0.6 + 1) / Math.sqrt(1 + hx * hx + hy * hy) / 1.5);
        const t = (h[i] - min) / span;
        const under = h[i] < seaLevel;
        const base: [number, number, number] = under ? [40, 80, 140] : [90 + 120 * t, 110 + 90 * t, 70 + 110 * t];
        rgb = [base[0] * (0.35 + 0.65 * lambert), base[1] * (0.35 + 0.65 * lambert), base[2] * (0.35 + 0.65 * lambert)];
      } else {
        const v = output.masks[view][i] * 255;
        rgb = [v, v, v];
      }
      img.data[i * 4] = rgb[0]; img.data[i * 4 + 1] = rgb[1]; img.data[i * 4 + 2] = rgb[2]; img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [output, view, seaLevel]);

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
        {!output && <div className='absolute inset-0 flex items-center justify-center text-dim'>Generating…</div>}
      </div>
    </div>
  );
}

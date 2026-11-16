// Brushing a mask on the preview landscape: while the paint tool is on, a left-drag in the viewport
// paints where the pointer's ray meets the ground (a ray march, then a bisection), and the camera's
// orbit is off for the stroke (the gizmo-drag events, as a transform gizmo takes the mouse).

import { useEffect, useRef } from 'react';
import { Raycaster, type CleoEngine, type LandscapeNode } from 'cleo';
import type { EventEmitter } from '@cleo/app-kit/utils/eventEmitter';

/** Where a ray meets a landscape, as map coordinates (u, v) 0..1, or null. */
export function rayToMap(origin: ArrayLike<number>, dir: ArrayLike<number>, land: LandscapeNode, size: number): [number, number] | null {
  const terrain = land.terrain;
  const half = size / 2;
  const ground = (x: number, z: number) => terrain.heightAt(x, z);
  const step = size / 400;
  const far = size * 4;
  let prevT = 0;
  const above = (t: number) => {
    const x = origin[0] + dir[0] * t, z = origin[2] + dir[2] * t, y = origin[1] + dir[1] * t;
    if (Math.abs(x) > half || Math.abs(z) > half) return null;
    return y - ground(x, z);
  };
  for (let t = 0; t < far; t += step) {
    const d = above(t);
    if (d === null) { prevT = t; continue; }
    if (d <= 0) {
      let lo = prevT, hi = t;
      for (let k = 0; k < 16; k++) {
        const mid = (lo + hi) / 2;
        const dm = above(mid);
        if (dm !== null && dm <= 0) hi = mid; else lo = mid;
      }
      const x = origin[0] + dir[0] * hi, z = origin[2] + dir[2] * hi;
      return [x / size + 0.5, z / size + 0.5];
    }
    prevT = t;
  }
  return null;
}

export function useViewportPaint(opts: {
  active: boolean;
  instance: CleoEngine | null;
  bus: EventEmitter;
  viewport: HTMLElement | null;
  landscape: () => LandscapeNode | null;
  size: number;
  onStroke: (u: number, v: number, phase: 'start' | 'move' | 'end') => void;
}): void {
  const live = useRef(opts);
  live.current = opts;
  useEffect(() => {
    const el = opts.viewport;
    if (!el || !opts.active || !opts.instance) return;
    let down = false;
    let last: [number, number] | null = null;
    const hit = (e: MouseEvent): [number, number] | null => {
      const { instance, landscape, size } = live.current;
      const cam = instance?.scene?.activeCamera?.camera;
      const land = landscape();
      if (!cam || !land) return null;
      const rect = el.getBoundingClientRect();
      const ray = Raycaster.screenToRay(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height, cam);
      return rayToMap(ray.origin, ray.direction, land, size);
    };
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || (e.target as HTMLElement | null)?.closest?.('[data-cleo-overlay]')) return;
      const p = hit(e);
      if (!p) return;
      down = true;
      last = p;
      live.current.bus.emit('GIZMO_DRAG_START');
      live.current.onStroke(p[0], p[1], 'start');
      e.preventDefault();
      e.stopPropagation();
    };
    const onMove = (e: MouseEvent) => {
      if (!down) return;
      const p = hit(e);
      if (!p) return;
      last = p;
      live.current.onStroke(p[0], p[1], 'move');
    };
    const onUp = () => {
      if (!down) return;
      down = false;
      live.current.bus.emit('GIZMO_DRAG_END');
      if (last) live.current.onStroke(last[0], last[1], 'end');
      last = null;
    };
    el.addEventListener('mousedown', onDown, true);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      el.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (down) live.current.bus.emit('GIZMO_DRAG_END');
    };
  }, [opts.active, opts.instance, opts.viewport]);
}

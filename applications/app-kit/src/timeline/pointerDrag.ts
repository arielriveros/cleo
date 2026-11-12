import { passedDragThreshold } from './timelineMath';

export interface PointerDragHandlers {
  /** Every move once the pointer has passed the threshold: the offset from where it went down. */
  onMove?: (dx: number, dy: number, event: PointerEvent) => void;
  /** On release: `moved` is false for a click (the pointer never passed the threshold). */
  onEnd?: (moved: boolean, event: PointerEvent) => void;
  /** Pixels before a press counts as a drag. Default 3. */
  threshold?: number;
}

/**
 * Follow a press to its release with WINDOW listeners, so the drag survives the pointer leaving the element
 * (or the element re-rendering under it). Tells a click from a drag by a small threshold, which is what lets
 * one handler both select (click) and move (drag) a timeline item. Returns a cancel function.
 */
export function startPointerDrag(down: { clientX: number; clientY: number }, handlers: PointerDragHandlers): () => void {
  const x0 = down.clientX, y0 = down.clientY;
  const threshold = handlers.threshold ?? 3;
  let moved = false;
  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - x0, dy = ev.clientY - y0;
    if (!moved && !passedDragThreshold(dx, dy, threshold)) return;
    moved = true;
    handlers.onMove?.(dx, dy, ev);
  };
  const stop = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
  };
  const up = (ev: PointerEvent) => { stop(); handlers.onEnd?.(moved, ev); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  return stop;
}

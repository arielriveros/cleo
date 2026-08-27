import { CleoEngine } from 'cleo';

/**
 * Mouse capture for viewport drags (camera orbit/pan, gizmo handles).
 *
 * The lock MUST target the canvas: `InputManager` flips `mouse.captured` only when
 * `document.pointerLockElement` is the canvas it was initialized with, and that flag is what feeds
 * `movementX/Y` into `mouse.velocity`. Locking the viewport div leaves the camera on a frozen cursor.
 *
 * Callers must not assume the lock succeeded — a browser rejects a re-lock issued too soon after an exit.
 */
export function captureViewport(instance: CleoEngine | null): void {
  const canvas = instance?.renderer?.canvas;
  if (!canvas || document.pointerLockElement === canvas) return;
  try {
    const locked = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
    locked?.catch(() => { /* denied (usually a too-soon re-lock); carry on uncaptured */ });
  } catch { /* older browsers throw instead of rejecting */ }
}

export function releaseViewport(): void {
  if (document.pointerLockElement) {
    try { document.exitPointerLock(); } catch { /* ignore */ }
  }
}

export const isViewportCaptured = (): boolean => !!document.pointerLockElement;

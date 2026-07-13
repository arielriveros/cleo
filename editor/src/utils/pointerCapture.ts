import { CleoEngine } from 'cleo';

/**
 * Mouse capture for viewport drags (camera orbit/pan, gizmo handles).
 *
 * The lock must target the *canvas*: `InputManager` only flips `mouse.captured` when
 * `document.pointerLockElement` is the canvas it was initialized with, and that flag is what makes it
 * feed `movementX/Y` into `mouse.velocity` instead of client coordinates. Locking the viewport div
 * instead would silently leave the camera reading a frozen cursor.
 *
 * Callers must not assume the lock succeeded — browsers reject a re-lock issued too soon after an
 * exit, and every drag path here still works (bounded by the window) without it.
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

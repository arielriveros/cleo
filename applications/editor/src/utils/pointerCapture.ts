import { InputSystem } from 'cleo';
import type { CleoEngine } from 'cleo';

/**
 * Mouse capture for viewport drags (camera orbit/pan, gizmo handles).
 *
 * These three names are kept, but the lock itself is no longer taken here: `InputSystem` is the single
 * owner of `requestPointerLock`/`exitPointerLock` in the whole app, and these delegate to it. Two
 * callers racing for the lock is not a theoretical problem — a browser REJECTS a re-lock issued too soon
 * after an exit, so a gizmo drag and a click-to-capture firing together used to leave the viewport
 * uncaptured with nothing to say why.
 *
 * The lock still targets the CANVAS, inside InputSystem: it flips `pointerLocked` only when
 * `document.pointerLockElement` is the canvas it bound to, and that flag is what turns pointer bindings
 * into relative motion. Locking the viewport div would leave the camera on a frozen cursor.
 *
 * Callers must not assume the lock succeeded.
 */
export function captureViewport(_instance: CleoEngine | null): void {
  InputSystem.instance.requestPointerLock();
}

export function releaseViewport(): void {
  InputSystem.instance.releasePointerLock();
}

export const isViewportCaptured = (): boolean => !!document.pointerLockElement;

import type { CleoEngine } from 'cleo';

/**
 * Where the view a pointer tool works through sits on screen, in client (CSS) pixels: the engine's
 * `viewRect()` -- the editing pane of a split viewport (Renderer.setViewLayout), else the whole viewport --
 * or `fallback`'s own box when there is no engine. A tool turns a mouse position into a ray against this
 * rectangle and `scene.activeCamera`, and projects back onto it, so it works in whichever pane is edited.
 */
export function viewRectOf(instance: CleoEngine | null | undefined, fallback: HTMLElement | null | undefined): DOMRect | null {
  if (instance?.viewport) return instance.viewRect();
  return fallback ? fallback.getBoundingClientRect() : null;
}

/**
 * Lay an absolutely positioned overlay root (a child of the viewport's positioned panel) over `rect`, so
 * coordinates projected against that rectangle land where they belong. With no split the rectangle is the
 * viewport itself and this is `inset: 0`.
 */
export function fitOverlayToView(root: HTMLElement, host: HTMLElement | null | undefined, rect: DOMRect): void {
  const box = host?.getBoundingClientRect();
  const left = box ? rect.left - box.left : 0;
  const top = box ? rect.top - box.top : 0;
  root.style.left = `${left}px`;
  root.style.top = `${top}px`;
  root.style.right = 'auto';
  root.style.bottom = 'auto';
  root.style.width = `${rect.width}px`;
  root.style.height = `${rect.height}px`;
}

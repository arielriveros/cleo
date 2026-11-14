// What the split viewport looks like right now, for the React pieces drawn over it (pane frames and
// headers, the game UI layer). Written by useViewportPanes once per change, read through
// `usePaneView` — an external store rather than context state, because the hook that owns it runs a
// per-frame loop and must not re-render the viewport to report a rectangle.

import { useSyncExternalStore } from 'react';
import type { PaneLayout } from './paneState';

/** A pane's rectangle relative to the viewport element, in CSS pixels. */
export interface PaneBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PaneViewState {
  /** Whether the viewport is split right now (a layout is chosen AND splitting is allowed here). */
  active: boolean;
  layout: PaneLayout;
  focused: number;
  /** One per pane, row-major; empty when not split. */
  boxes: PaneBox[];
}

let current: PaneViewState = { active: false, layout: 'single', focused: 0, boxes: [] };
const listeners = new Set<() => void>();

function sameBoxes(a: PaneBox[], b: PaneBox[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++)
    if (a[i].left !== b[i].left || a[i].top !== b[i].top || a[i].width !== b[i].width || a[i].height !== b[i].height)
      return false;
  return true;
}

/** Publish the viewport's split. A no-op when nothing changed, so it is cheap to call every frame. */
export function setPaneView(next: PaneViewState): void {
  if (next.active === current.active && next.layout === current.layout && next.focused === current.focused
      && sameBoxes(next.boxes, current.boxes)) return;
  current = next;
  for (const listener of listeners) listener();
}

export function paneView(): PaneViewState {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function usePaneView(): PaneViewState {
  return useSyncExternalStore(subscribe, paneView, paneView);
}

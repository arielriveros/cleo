import { describe, it, expect } from 'vitest';
import type { CameraNode } from 'cleo';
import { zoomOrthoExtents } from '../src/engine/viewCamera';
import { fitOverlayToView } from '../src/engine/viewRect';

// The pieces of a split viewport the app-kit owns: zooming an orthographic pane, and laying the gizmo
// overlays over the editing pane rather than the whole viewport.

const orthoNode = (half: number) => ({ camera: { top: half, bottom: -half, left: -half, right: half } }) as unknown as CameraNode;

describe('zoomOrthoExtents', () => {
  it('zooms in on a wheel up and out on a wheel down, symmetrically', () => {
    const node = orthoNode(10);
    zoomOrthoExtents(node, -100);
    expect(node.camera.top).toBeCloseTo(9, 6);
    expect(node.camera.bottom).toBeCloseTo(-9, 6);
    zoomOrthoExtents(node, 200);
    expect(node.camera.left).toBeCloseTo(-10.8, 6);
  });
  it('never collapses or inverts the view on a fast scroll', () => {
    const node = orthoNode(0.2);
    zoomOrthoExtents(node, -100000);
    expect(node.camera.top).toBeGreaterThan(0);
    expect(node.camera.bottom).toBeLessThan(0);
    expect(Math.abs(node.camera.top)).toBeGreaterThanOrEqual(0.1);
  });
  it('leaves the view alone without a wheel reading', () => {
    const node = orthoNode(5);
    zoomOrthoExtents(node, 0);
    expect(node.camera.top).toBe(5);
  });
});

describe('fitOverlayToView', () => {
  const box = (left: number, top: number, width: number, height: number) =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect;

  it('places an overlay root over the editing pane, relative to the viewport panel', () => {
    const root = { style: {} as Record<string, string> } as unknown as HTMLElement;
    const host = { getBoundingClientRect: () => box(300, 50, 1000, 600) } as unknown as HTMLElement;
    fitOverlayToView(root, host, box(800, 350, 500, 300));
    expect(root.style.left).toBe('500px');
    expect(root.style.top).toBe('300px');
    expect(root.style.width).toBe('500px');
    expect(root.style.height).toBe('300px');
    expect(root.style.right).toBe('auto');
  });

  it('is the whole panel when the view is the whole viewport', () => {
    const root = { style: {} as Record<string, string> } as unknown as HTMLElement;
    const host = { getBoundingClientRect: () => box(300, 50, 1000, 600) } as unknown as HTMLElement;
    fitOverlayToView(root, host, box(300, 50, 1000, 600));
    expect([root.style.left, root.style.top, root.style.width, root.style.height]).toEqual(['0px', '0px', '1000px', '600px']);
  });
});

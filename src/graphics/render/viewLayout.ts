import type { CameraNode } from '../../core/scene/nodes/cameraNode';

/**
 * The canvas split into equal panes (the editor's multi-pane viewport). One pane is the PRIMARY view:
 * `scene.activeCamera`, rendered by the full frame with every temporal effect. The others are PREVIEW
 * views of the same scene through their own camera, rendered after it in the same frame with nothing
 * temporal (Renderer `_renderPreviews`). GL-free, so the arithmetic is testable on its own.
 */

/** A rectangle of the canvas in canvas pixels (which are CSS pixels), origin top-left. */
export interface PaneRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** One pane of a {@link ViewLayout}. */
export interface ViewPane {
    /** The pane's camera. Ignored for the primary pane, which is always `scene.activeCamera`. */
    camera: CameraNode | null;
    /** Re-render every frame. Otherwise only when something marked the pane dirty. */
    realtime: boolean;
}

/** How the canvas is split. `panes` is row-major, `cols * rows` long. */
export interface ViewLayout {
    cols: 1 | 2;
    rows: 1 | 2;
    /** Index into `panes` of the primary view. */
    primary: number;
    panes: ViewPane[];
}

/**
 * The panes of a `cols` by `rows` split of a `width` by `height` canvas, row-major from the top left.
 * Every pane has the same integer size, because the frame renders each at one internal resolution; the
 * pixels that do not divide evenly are left over on the right and bottom edges (cleared, never drawn).
 */
export function paneRects(width: number, height: number, cols: number, rows: number): PaneRect[] {
    const w = Math.max(1, Math.floor(width / Math.max(1, cols)));
    const h = Math.max(1, Math.floor(height / Math.max(1, rows)));
    const rects: PaneRect[] = [];
    for (let row = 0; row < rows; row++)
        for (let col = 0; col < cols; col++) rects.push({ x: col * w, y: row * h, w, h });
    return rects;
}

/**
 * `rect` as a render-pass viewport on a target `targetHeight` tall: `[x, y, width, height]`, with y
 * counted from the top on a device whose framebuffer origin is top-left (WebGPU) and from the bottom
 * otherwise (WebGL2). See `DeviceConventions.originTopLeft`.
 */
export function paneViewport(rect: PaneRect, targetHeight: number, originTopLeft: boolean): [number, number, number, number] {
    return [rect.x, originTopLeft ? rect.y : targetHeight - rect.y - rect.h, rect.w, rect.h];
}

/** True when `layout` describes a real split: more than one pane, the right count, a primary in range. */
export function isSplitLayout(layout: ViewLayout | null): layout is ViewLayout {
    if (!layout) return false;
    const count = layout.cols * layout.rows;
    return count > 1 && layout.panes.length === count && layout.primary >= 0 && layout.primary < count;
}

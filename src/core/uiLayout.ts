import { mat4, vec3 } from "gl-matrix";
import { clamp, lerp, RAD2DEG } from "./math";

/**
 * The UI layout solve as pure functions over plain rects, testable without a GL context.
 *
 * UI space is **top-left origin, Y grows DOWN**, matching CSS and the DOM layer that consumes these
 * rects, and NOT WebGL NDC, which is bottom-up. {@link projectToScreen} is the one place the two meet
 * and does the flip; everything downstream of it is DOM-handed.
 */

/** An axis-aligned rectangle in UI space. `x`/`y` are the top-left corner. */
export interface UIRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** How a UI root converts the viewport into the reference-resolution space its children lay out in. */
export type UIScaleMode = 'constantPixel' | 'scaleWithScreen' | 'constantPhysical';

/** Whether a UI root anchors to the viewport or to a point in the 3D world. */
export type UISpace = 'screen' | 'world';

/** Writes `x/y/width/height` into `out` and returns it, so callers can reuse one live object. */
export function setRect(out: UIRect, x: number, y: number, width: number, height: number): UIRect {
    out.x = x;
    out.y = y;
    out.width = width;
    out.height = height;
    return out;
}

export function copyRect(out: UIRect, from: UIRect): UIRect {
    return setRect(out, from.x, from.y, from.width, from.height);
}

export function rectsEqual(a: UIRect, b: UIRect): boolean {
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * Resolve one element's rect from its anchors and offsets against its parent's rect — `RectTransform`'s
 * solve, branch-free, one line per edge:
 *
 *     minX = parent.x + anchorMin.x * parent.width + offsetMin.x
 *     maxX = parent.x + anchorMax.x * parent.width + offsetMax.x
 *
 * When `anchorMin[i] === anchorMax[i]` the element is PINNED on that axis and the offsets read as
 * position + size; when they differ it is STRETCHED and they read as insets from each edge — one stored
 * shape either way. A negative extent (offsets crossed over) is clamped to zero, never inverted.
 */
export function solveRect(
    out: UIRect,
    parent: UIRect,
    anchorMin: readonly [number, number],
    anchorMax: readonly [number, number],
    offsetMin: readonly [number, number],
    offsetMax: readonly [number, number],
): UIRect {
    const minX = parent.x + anchorMin[0] * parent.width + offsetMin[0];
    const maxX = parent.x + anchorMax[0] * parent.width + offsetMax[0];
    const minY = parent.y + anchorMin[1] * parent.height + offsetMin[1];
    const maxY = parent.y + anchorMax[1] * parent.height + offsetMax[1];
    return setRect(out, minX, minY, Math.max(0, maxX - minX), Math.max(0, maxY - minY));
}

/**
 * The scale a UI root applies to convert reference units into viewport pixels. `scaleWithScreen` must
 * interpolate in LOG space, not linear: linearly blending two ratios warps everything between the
 * endpoints.
 *
 * @param match 0 = follow width only, 1 = follow height only, 0.5 = split the difference.
 */
export function rootScale(
    mode: UIScaleMode,
    viewportWidth: number,
    viewportHeight: number,
    referenceWidth: number,
    referenceHeight: number,
    match: number,
    dpr: number = 1,
    referenceDpr: number = 1,
): number {
    if (mode === 'constantPixel') return 1;
    if (mode === 'constantPhysical') return referenceDpr > 0 ? dpr / referenceDpr : 1;

    // A zero reference resolution is authorable in the inspector, so guard every denominator.
    if (referenceWidth <= 0 || referenceHeight <= 0) return 1;
    const byWidth = viewportWidth / referenceWidth;
    const byHeight = viewportHeight / referenceHeight;
    if (byWidth <= 0 || byHeight <= 0) return 1;
    return Math.pow(2, lerp(Math.log2(byWidth), Math.log2(byHeight), clamp(match, 0, 1)));
}

/** Result of projecting a world point into UI space. */
export interface ScreenProjection {
    /** UI-space X in CSS pixels, top-left origin. */
    x: number;
    /** UI-space Y in CSS pixels, **Y down**. */
    y: number;
    /** Distance from the camera along the view direction. Negative when behind. */
    distance: number;
    /** False when the point is behind the camera plane. */
    inFront: boolean;
}

/**
 * Project a world position into UI space through a view-projection matrix.
 *
 * `w <= 0` is the only reliable behind-camera test: the perspective divide flips the sign, so a point
 * behind the camera otherwise projects to a plausible on-screen coordinate, and a distance check is not
 * equivalent for off-axis points. The `1 -` on Y is the NDC-bottom-up to UI-top-down flip.
 *
 * @param viewProj Row-major-consumed `projection * view`, i.e. what `mat4.multiply(out, proj, view)` gives.
 */
export function projectToScreen(
    viewProj: mat4,
    world: vec3,
    viewportWidth: number,
    viewportHeight: number,
): ScreenProjection {
    const x = world[0], y = world[1], z = world[2];
    // Manual transform: gl-matrix's vec3.transformMat4 divides by w and discards it, and the guard needs w.
    const cx = viewProj[0] * x + viewProj[4] * y + viewProj[8] * z + viewProj[12];
    const cy = viewProj[1] * x + viewProj[5] * y + viewProj[9] * z + viewProj[13];
    const cw = viewProj[3] * x + viewProj[7] * y + viewProj[11] * z + viewProj[15];

    if (cw <= 1e-6)
        return { x: 0, y: 0, distance: cw, inFront: false };

    const ndcX = cx / cw;
    const ndcY = cy / cw;
    return {
        x: (ndcX * 0.5 + 0.5) * viewportWidth,
        y: (1 - (ndcY * 0.5 + 0.5)) * viewportHeight,  // NDC is bottom-up, UI space is top-down
        distance: cw,
        inFront: true,
    };
}

/**
 * Scale for a world-space UI root, so it shrinks with distance like the thing it labels.
 *
 * An orthographic projection has no perspective divide, so distance must not affect its apparent size:
 * theirs is a constant pixels-per-world-unit taken from the VERTICAL extent, because
 * `Camera.projectionMatrix` scales left/right by the aspect ratio and leaves top/bottom alone.
 *
 * @param distance Camera-space depth from {@link projectToScreen}.
 */
export function worldUIScale(
    orthographic: boolean,
    distance: number,
    referenceDistance: number,
    minScale: number,
    maxScale: number,
    viewportHeight: number,
    orthoVerticalExtent: number,
): number {
    if (orthographic) {
        const perUnit = orthoVerticalExtent > 0 ? viewportHeight / orthoVerticalExtent : 1;
        return clamp(perUnit, minScale, maxScale);
    }
    if (distance <= 1e-6) return maxScale;
    return clamp(referenceDistance / distance, minScale, maxScale);
}

/** Intersection of two rects; a non-overlapping pair yields a zero-size rect at `a`'s corner. */
export function intersectRect(out: UIRect, a: UIRect, b: UIRect): UIRect {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.width, b.x + b.width);
    const bottom = Math.min(a.y + a.height, b.y + b.height);
    return setRect(out, x, y, Math.max(0, right - x), Math.max(0, bottom - y));
}

/** True when `rect` lies entirely outside `bounds`, inflated by `margin` on every side. */
export function rectOffscreen(rect: UIRect, bounds: UIRect, margin: number = 0): boolean {
    return rect.x + rect.width < bounds.x - margin
        || rect.y + rect.height < bounds.y - margin
        || rect.x > bounds.x + bounds.width + margin
        || rect.y > bounds.y + bounds.height + margin;
}

/** One child's contribution to a stack layout. */
export interface StackItem {
    /** Size along the stack axis, before flex distribution. */
    size: number;
    /** Share of the leftover space this item absorbs. 0 = fixed size. */
    flex: number;
}

export type StackJustify = 'start' | 'center' | 'end' | 'spaceBetween' | 'spaceAround';

/**
 * Distribute children along a stack's main axis, returning each one's offset and final size. Flex items
 * absorb leftover space in proportion to their `flex` weight; when anything flexes, the justification is
 * ignored (the same rule CSS flexbox follows). Results are written into `out`, reused across frames.
 */
export function stackLayout(
    out: { offset: number, size: number }[],
    items: readonly StackItem[],
    available: number,
    gap: number,
    justify: StackJustify,
    reverse: boolean,
): { offset: number, size: number }[] {
    out.length = items.length;
    if (items.length === 0) return out;

    const totalGap = gap * (items.length - 1);
    let fixed = 0;
    let flexSum = 0;
    for (const item of items) {
        if (item.flex > 0) flexSum += item.flex;
        else fixed += item.size;
    }

    const leftover = available - totalGap - fixed;
    // Only the flex share is distributed; a negative leftover means the fixed children already overflow,
    // so flex children collapse to zero rather than going negative.
    const perFlex = flexSum > 0 ? Math.max(0, leftover) / flexSum : 0;

    let used = totalGap;
    for (let i = 0; i < items.length; i++) {
        const size = items[i].flex > 0 ? items[i].flex * perFlex : items[i].size;
        out[i] = { offset: 0, size };
        used += size;
    }

    const slack = Math.max(0, available - used);
    let cursor = 0;
    let between = gap;
    if (flexSum > 0) {
        // Nothing left to justify — flex already consumed it.
    } else if (justify === 'center') cursor = slack / 2;
    else if (justify === 'end') cursor = slack;
    else if (justify === 'spaceBetween' && items.length > 1) between = gap + slack / (items.length - 1);
    else if (justify === 'spaceAround') {
        const pad = slack / (items.length * 2);
        cursor = pad;
        between = gap + pad * 2;
    }

    for (let i = 0; i < items.length; i++) {
        const index = reverse ? items.length - 1 - i : i;
        out[index].offset = cursor;
        cursor += out[index].size + between;
    }
    return out;
}

/** Where an offscreen world anchor was pinned, and which way it lies. */
export interface EdgeClamp {
    /** Clamped top-left of the element, in UI pixels. */
    x: number;
    y: number;
    /** Direction from the viewport centre toward the anchor: degrees, 0 = right, growing clockwise. */
    angleDeg: number;
    /** True when the anchor was outside the viewport and had to be pulled in. */
    offscreen: boolean;
}

/**
 * Pin an element to the viewport edge when its anchor leaves the screen, and report which way it went.
 * `angleDeg` is measured in UI space, so it grows CLOCKWISE (Y is down) — what a CSS `rotate()` wants.
 *
 * @param x,y   Desired top-left of the element, in UI pixels.
 * @param behind Pass true when the anchor is behind the camera; the point is then mirrored through the
 *               viewport centre before clamping, because a projection from behind lands on the OPPOSITE
 *               side of the screen.
 */
export function edgeClamp(
    x: number, y: number, width: number, height: number,
    viewportWidth: number, viewportHeight: number,
    margin: number = 0,
    behind: boolean = false,
): EdgeClamp {
    const cx = viewportWidth / 2;
    const cy = viewportHeight / 2;

    let px = x + width / 2;
    let py = y + height / 2;
    if (behind) {
        px = 2 * cx - px;
        py = 2 * cy - py;
    }

    const angleDeg = Math.atan2(py - cy, px - cx) * RAD2DEG;

    const minX = margin;
    const minY = margin;
    const maxX = Math.max(minX, viewportWidth - width - margin);
    const maxY = Math.max(minY, viewportHeight - height - margin);

    const wantX = px - width / 2;
    const wantY = py - height / 2;
    const clampedX = clamp(wantX, minX, maxX);
    const clampedY = clamp(wantY, minY, maxY);

    return {
        x: clampedX,
        y: clampedY,
        angleDeg,
        offscreen: behind || clampedX !== wantX || clampedY !== wantY,
    };
}

/**
 * The CSS `matrix3d` that maps the rect `(0,0)-(w,h)` onto four projected screen corners — how a
 * world-space UI panel lies flat in the scene without a CSS `perspective`. The quad is planar, so its
 * image under a perspective camera is exactly a 2D homography.
 *
 * @param corners Projected screen positions of the rect's corners, in the order
 *                top-left, top-right, bottom-right, bottom-left.
 * @returns A 16-element column-major `matrix3d`, or null when the quad is degenerate (zero area, or a
 *          corner behind the camera) and no transform can represent it.
 */
export function quadHomography(
    corners: readonly (readonly [number, number] | null)[],
    width: number,
    height: number,
): number[] | null {
    if (corners.length !== 4 || width <= 0 || height <= 0) return null;
    for (const c of corners) if (!c || !isFinite(c[0]) || !isFinite(c[1])) return null;

    const src: [number, number][] = [[0, 0], [width, 0], [width, height], [0, height]];
    const dst = corners as readonly (readonly [number, number])[];

    // Solve the 8 unknowns of the homography (h33 fixed at 1) by Gaussian elimination on the standard
    // 8x8 DLT system — two rows per corner correspondence.
    const a: number[][] = [];
    const b: number[] = [];
    for (let i = 0; i < 4; i++) {
        const [sx, sy] = src[i];
        const [dx, dy] = dst[i];
        a.push([sx, sy, 1, 0, 0, 0, -sx * dx, -sy * dx]);
        b.push(dx);
        a.push([0, 0, 0, sx, sy, 1, -sx * dy, -sy * dy]);
        b.push(dy);
    }

    const n = 8;
    for (let col = 0; col < n; col++) {
        let pivot = col;
        for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
        if (Math.abs(a[pivot][col]) < 1e-9) return null; // degenerate quad
        [a[col], a[pivot]] = [a[pivot], a[col]];
        [b[col], b[pivot]] = [b[pivot], b[col]];

        const d = a[col][col];
        for (let c = col; c < n; c++) a[col][c] /= d;
        b[col] /= d;

        for (let r = 0; r < n; r++) {
            if (r === col) continue;
            const f = a[r][col];
            if (f === 0) continue;
            for (let c = col; c < n; c++) a[r][c] -= f * a[col][c];
            b[r] -= f * b[col];
        }
    }

    const [h11, h12, h13, h21, h22, h23, h31, h32] = b;
    // CSS matrix3d is COLUMN-major and its perspective terms are the fourth ROW, i.e. elements 3, 7 and
    // 15 in column-major order.
    return [
        h11, h21, 0, h31,
        h12, h22, 0, h32,
        0, 0, 1, 0,
        h13, h23, 0, 1,
    ];
}

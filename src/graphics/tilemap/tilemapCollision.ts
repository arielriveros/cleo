// Turning a chunk's solid cells into as few collider boxes as possible: greedy meshing collapses solid
// regions into maximal rectangles, where one box per tile would put 1024 bodies in a full chunk.
// Pure integer work with no physics types in scope.

/** An axis-aligned run of solid cells, inclusive on both ends. */
export interface SolidBox {
    c0: number; r0: number; c1: number; r1: number;
}

/**
 * Cover every solid cell of a `w` x `h` bitmap with non-overlapping rectangles: the longest horizontal
 * run from each unclaimed cell, extended downward while the row below matches. O(w*h).
 */
export function greedyMerge(solid: Uint8Array, w: number, h: number): SolidBox[] {
    const boxes: SolidBox[] = [];
    if (w <= 0 || h <= 0) return boxes;
    const used = new Uint8Array(w * h);

    for (let r = 0; r < h; r++) {
        for (let c = 0; c < w; c++) {
            const start = r * w + c;
            if (!solid[start] || used[start]) continue;

            let c1 = c;
            while (c1 + 1 < w && solid[r * w + c1 + 1] && !used[r * w + c1 + 1]) c1++;

            let r1 = r;
            grow: while (r1 + 1 < h) {
                const below = (r1 + 1) * w;
                for (let cc = c; cc <= c1; cc++) {
                    if (!solid[below + cc] || used[below + cc]) break grow;
                }
                r1++;
            }

            for (let rr = r; rr <= r1; rr++)
                for (let cc = c; cc <= c1; cc++) used[rr * w + cc] = 1;

            boxes.push({ c0: c, r0: r, c1, r1 });
        }
    }
    return boxes;
}

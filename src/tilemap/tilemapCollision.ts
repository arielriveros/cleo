// Turning a chunk's solid cells into as few collider boxes as possible.
//
// One box per solid tile is correct but ruinous: a 32x32 chunk of solid ground would put 1024 static
// bodies in the world, and a modest map hundreds of thousands. Greedy meshing collapses solid regions
// into maximal rectangles instead — an open field becomes a single box, and only genuinely ragged
// geometry (a checkerboard is the worst case) approaches one box per cell.
//
// Pure integer work with no physics types in scope, so it is directly unit-testable.

/** An axis-aligned run of solid cells, inclusive on both ends. */
export interface SolidBox {
    c0: number; r0: number; c1: number; r1: number;
}

/**
 * Cover every solid cell of a `w` x `h` bitmap with non-overlapping rectangles.
 *
 * Greedy in two passes per rectangle: take the longest horizontal run starting at the first unclaimed
 * solid cell, then extend it downward for as long as the row below matches it exactly. Every cell is
 * visited a constant number of times, so this is O(w*h) despite the nested loops.
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

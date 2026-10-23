// Coarse terrain for the far shadow cascade.
//
// The far cascade covers the whole landscape at most of a metre per texel, and drew it chunk by chunk: a
// thousand draws for the Valley, each its own vertex buffer, which WebGL2 pays for on the GPU timeline
// too (7.5 ms a redraw). These are the same surface in a few dozen meshes: the heightfield cut into
// square blocks of chunks, each sampled every `step` grid points — the coarsest level a chunk draws at
// anyway — as positions only, which is all a depth pass reads.
//
// Pure: arrays in, arrays out. The renderer owns the GPU meshes built from them.

/** One block's span of the height grid, in vertices (inclusive). */
export interface ShadowBlockSpan {
    c0: number; r0: number; c1: number; r1: number;
}

/**
 * The blocks covering a `resolution` x `resolution` height grid cut into chunks of `chunkQuads` quads,
 * `blockChunks` x `blockChunks` chunks to a block, row-major. Edge blocks are shorter where the grid is.
 */
export function shadowBlockSpans(resolution: number, chunkQuads: number, blockChunks: number): ShadowBlockSpan[] {
    const quads = resolution - 1;
    const span = Math.max(1, chunkQuads * blockChunks);
    const out: ShadowBlockSpan[] = [];
    for (let r0 = 0; r0 < quads; r0 += span)
        for (let c0 = 0; c0 < quads; c0 += span)
            out.push({ c0, r0, c1: Math.min(c0 + span, quads), r1: Math.min(r0 + span, quads) });
    return out;
}

/** The grid lines a block samples: every `step` from `a`, and always `b` itself so blocks meet exactly. */
function samples(a: number, b: number, step: number): number[] {
    const out: number[] = [];
    for (let g = a; g < b; g += step) out.push(g);
    out.push(b);
    return out;
}

/** A block's mesh data: positions only (x, y, z per vertex), triangle indices, and its local bounds. */
export interface ShadowBlockData {
    positions: Float32Array;
    indices: Uint32Array;
    min: [number, number, number];
    max: [number, number, number];
}

/**
 * Build one block from the height grid: vertex (gx, gz) at `(-size/2 + gx * element, heights[gz * R + gx],
 * -size/2 + gz * element)` — the terrain chunks' own local frame — and triangles wound as the chunks wind
 * theirs (up-facing counter-clockwise), so the same front-face culling applies.
 */
export function buildShadowBlock(heights: ArrayLike<number>, resolution: number, element: number, size: number,
                                 span: ShadowBlockSpan, step: number): ShadowBlockData {
    const R = resolution, half = size / 2;
    const xs = samples(span.c0, span.c1, Math.max(1, step | 0));
    const zs = samples(span.r0, span.r1, Math.max(1, step | 0));
    const cols = xs.length, rows = zs.length;
    const positions = new Float32Array(cols * rows * 3);
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    let o = 0;
    for (let j = 0; j < rows; j++) {
        const gz = zs[j];
        for (let i = 0; i < cols; i++) {
            const gx = xs[i];
            const x = -half + gx * element, y = heights[gz * R + gx], z = -half + gz * element;
            positions[o++] = x; positions[o++] = y; positions[o++] = z;
            if (x < min[0]) min[0] = x; if (y < min[1]) min[1] = y; if (z < min[2]) min[2] = z;
            if (x > max[0]) max[0] = x; if (y > max[1]) max[1] = y; if (z > max[2]) max[2] = z;
        }
    }
    const indices = new Uint32Array((cols - 1) * (rows - 1) * 6);
    let k = 0;
    for (let j = 0; j < rows - 1; j++)
        for (let i = 0; i < cols - 1; i++) {
            const tl = j * cols + i, tr = tl + 1, bl = tl + cols, br = bl + 1;
            indices[k++] = tl; indices[k++] = bl; indices[k++] = tr;
            indices[k++] = tr; indices[k++] = bl; indices[k++] = br;
        }
    return { positions, indices, min, max };
}

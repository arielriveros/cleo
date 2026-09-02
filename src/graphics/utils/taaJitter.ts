import { mat4 } from 'gl-matrix';
import { haltonSequence } from './halton';

/**
 * The sub-pixel offset TAA rasterizes each frame through, as a clip-space matrix.
 *
 * Separated from the renderer because it is the one piece of the jitter that can be checked without a
 * GPU, and because a sign error here is invisible on whichever backend you happen to be looking at.
 * `tests/taaJitter.test.ts` pins the magnitude, the sign and the composition order.
 */

/** How many frames the sequence cycles over before repeating. */
export const TAA_PHASES = 8;

/** Interleaved (x, y) pixel offsets, one pair per phase, averaging to zero. See {@link haltonSequence}. */
export const TAA_JITTER: Float32Array = haltonSequence(TAA_PHASES);

/**
 * Build the clip-space translation for one phase: `x' = x + jx * w`, `y' = y + jy * w`.
 *
 * A constant screen-space shift at every depth, which is what makes it a sub-pixel sample offset
 * rather than a skew. NDC x spans [-1, 1] over `width` pixels, so one pixel is `2 / width` of NDC
 * *regardless of the projection* — which is why this is a post-multiply onto the finished projection
 * rather than a nudge to the frustum extents. It then applies unchanged to an orthographic camera, and
 * to a perspective override of one.
 *
 * Writes column 3, rows 0 and 1 — gl-matrix indices 12 and 13, the translation column.
 */
export function jitterMatrix(out: mat4, phase: number, width: number, height: number): mat4 {
    const i = (((phase % TAA_PHASES) + TAA_PHASES) % TAA_PHASES) * 2;
    mat4.identity(out);
    out[12] = (2 * TAA_JITTER[i]) / width;
    out[13] = (2 * TAA_JITTER[i + 1]) / height;
    return out;
}

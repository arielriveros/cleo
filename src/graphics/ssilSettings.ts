// How the SSIL trace (shaders/wgsl/ssil.wgsl) spends the per-pixel sample budget, free of GL so the
// mapping is unit-tested.
//
// The budget is still the `ssaoSamples` number the quality tiers and every saved project carry, and it
// keeps its meaning as a COST. The old hemisphere kernel took that many depth fetches per pixel; a trace
// step costs about half as much again as one of those (it also places the sample in its slice), and the
// accumulation and radiance copy add a little per pixel on top. So the trace takes two thirds as many
// fetches as the budget names — `slices * 2 sides * steps` — which kept the high tier within about a
// tenth of a millisecond of the old pass at 1080p, and the tiers on the cost ladder they were tuned for.

/** Upper bounds the shader is compiled for (MAX_SLICES / MAX_STEPS in ssil.wgsl). */
export const SSIL_MAX_SLICES = 4;
export const SSIL_MAX_STEPS = 16;

/** A budget at or above this buys a second slice rather than longer ones. */
const TWO_SLICE_BUDGET = 48;

/** Old-kernel fetches per trace fetch. See the header. */
const FETCH_COST = 1.5;

export interface SsilTraceShape {
    /** Screen-space directions searched per pixel. */
    slices: number;
    /** Depth samples per side of each slice. */
    steps: number;
}

/**
 * Split a sample budget into slices and steps.
 *
 * One slice until the budget is large: the noise rotates every frame and the temporal pass averages
 * across frames, so a second slice mostly buys what a few frames of history already give — while longer
 * slices find occluders the history never would. 64 (ultra) -> 2 x 11, 24 (high) -> 1 x 8,
 * 16 (medium) -> 1 x 5.
 */
export function ssilTraceShape(samples: number): SsilTraceShape {
    const budget = Number.isFinite(samples) ? Math.max(1, Math.round(samples)) : 24;
    const slices = budget >= TWO_SLICE_BUDGET ? 2 : 1;
    const steps = Math.min(SSIL_MAX_STEPS, Math.max(2, Math.round(budget / (FETCH_COST * 2 * slices))));
    return { slices, steps };
}

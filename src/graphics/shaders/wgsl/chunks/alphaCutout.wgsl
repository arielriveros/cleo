// Mip-aware alpha testing — the cutout every alpha-tested shader runs (leaf cards, grass, fences).
//
// THE PROBLEM. A cutout tests the texture's alpha against a fixed threshold, and the mip chain is a box
// filter: every level down averages a leaf's opaque texels with the transparent background around it. A
// 0/1 leaf mask is 0.5-ish one level down and lower still after that, so the further a tree is, the
// more of its foliage falls under the cutoff — distant pines thin out, and what survives flips on and
// off with every sub-pixel move of the camera or TAA jitter. That shimmer is what TAA cannot remove: it
// is real frame-to-frame change, and variance clipping keeps it.
//
// THE FIX (Ben Golus, "Anti-aliased Alpha Test"): raise the tested alpha with the mip level the fetch is
// reading, so a minified card keeps roughly the coverage it had at full resolution. No asset changes, no
// extra fetch: one log2 from gradients every caller already has.
//
// Included ONCE by each program that alpha-tests (the include resolver has no include-once guard).

/** How much each mip level raises the tested alpha. 0.25 keeps a typical leaf mask's coverage. */
const CUTOUT_MIP_SCALE: f32 = 0.25;

/**
 * The mip level a fetch with these uv gradients reads, from the LARGER axis — the level the hardware
 * picks (without anisotropy), which is the level whose averaged alpha is being tested. Floored at 0: a
 * magnified texture is read at full resolution and needs no help.
 */
fn cutoutMip(dx: vec2<f32>, dy: vec2<f32>, dims: vec2<f32>) -> f32 {
    let a = dx * dims;
    let b = dy * dims;
    return max(0.5 * log2(max(max(dot(a, a), dot(b, b)), 1e-12)), 0.0);
}

/** `alpha` as the cutoff should see it: scaled up with the mip level its texture is read at. */
fn cutoutAlpha(alpha: f32, dx: vec2<f32>, dy: vec2<f32>, dims: vec2<u32>) -> f32 {
    return alpha * (1.0 + cutoutMip(dx, dy, vec2<f32>(dims)) * CUTOUT_MIP_SCALE);
}

// Back-to-front ordering for alpha-blended particles: a bitonic sort over (key, slot) pairs, one
// compare-exchange step per pass. Shared by its two harnesses exactly as the simulation core is —
// particleSortCompute.wgsl on WebGPU, particleSort.wgsl (ping-pong draws) on WebGL2.
//
// Bitonic because it is the sort that maps onto a GPU without atomics or scratch memory: every element
// does the same fixed work per step, and the step sequence depends only on N, never on the data. The
// cost is log2(N)·(log2(N)+1)/2 passes — 66 for 2048 particles — which is why sorting is opt-in per
// emitter and capped at 65536.
//
// The pass kinds, by `u_sortStep.w`:
//   0 — KEYS: element i becomes (key, i). Key is minus the view distance, so ascending order is
//       back to front; dead slots and padding get +LARGE and sink to the end.
//   1 — STEP: compare-exchange element i with i ^ j inside bitonic blocks of size k.

#include "./particleCommon.wgsl"

struct ParticleSortUniforms {
    u_sortEmitter: mat4x4<f32>,   // simulation space -> world, for local-space emitters
    u_sortStep: vec4<f32>,        // j, k, N (power of two), pass kind
    u_sortSize: vec4<f32>,        // sort texture width, state texture width, capacity, local space
    u_sortCam: vec4<f32>,         // camera position xyz, 0
};
@group(1) @binding(0) var<uniform> u_sort: ParticleSortUniforms;

@group(0) @binding(0) var u_sortIn_texture: texture_2d<f32>;
@group(0) @binding(1) var u_p0_texture: texture_2d<f32>;
@group(0) @binding(2) var u_p1_texture: texture_2d<f32>;

const SORT_SINK: f32 = 3.0e38;

fn sortKey(i: u32) -> vec4<f32> {
    let capacity = u32(u_sort.u_sortSize.z);
    if (i >= capacity) { return vec4<f32>(SORT_SINK, f32(i), 0.0, 0.0); }
    let texel = particleTexel(i, u32(u_sort.u_sortSize.y));
    let life = textureLoad(u_p1_texture, texel, 0).w;
    if (life <= 0.0) { return vec4<f32>(SORT_SINK, f32(i), 0.0, 0.0); }
    var p = textureLoad(u_p0_texture, texel, 0).xyz;
    if (u_sort.u_sortSize.w > 0.5) { p = (u_sort.u_sortEmitter * vec4<f32>(p, 1.0)).xyz; }
    return vec4<f32>(-distance(p, u_sort.u_sortCam.xyz), f32(i), 0.0, 0.0);
}

fn sortStep(i: u32) -> vec4<f32> {
    let width = u32(u_sort.u_sortSize.x);
    let j = u32(u_sort.u_sortStep.x);
    let k = u32(u_sort.u_sortStep.y);
    let partner = i ^ j;
    let mine = textureLoad(u_sortIn_texture, particleTexel(i, width), 0);
    let theirs = textureLoad(u_sortIn_texture, particleTexel(partner, width), 0);
    let ascending = (i & k) == 0u;
    // The lower index of the pair keeps the smaller key in an ascending block, the larger otherwise;
    // ties break on the slot so the order is total and never flickers between frames.
    let mineFirst = mine.x < theirs.x || (mine.x == theirs.x && mine.y < theirs.y);
    let keepMine = select(!mineFirst, mineFirst, (i < partner) == ascending);
    return select(theirs, mine, keepMine);
}

fn sortValue(i: u32) -> vec4<f32> {
    if (u_sort.u_sortStep.w < 0.5) { return sortKey(i); }
    return sortStep(i);
}

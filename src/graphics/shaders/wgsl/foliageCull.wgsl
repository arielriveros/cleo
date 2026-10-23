// GPU-driven foliage culling (WebGPU): one draw bucket's per-INSTANCE cull. The compute half of
// graphics/foliageGpuCulling.ts.
//
// The CPU still decides which CELLS feed a bucket (distance cull with its hysteresis, the occlusion test,
// the detail level a cell straddles, the density prefix) — it is cheap per cell and it owns the admission
// state. What it cannot afford is the per-instance half, which is what this does for every instance of
// every cell the bucket holds:
//
//   - the LOD crossfade test, exactly as chunks/instancedVertex.wgsl computes it. A cell straddling a band
//     edge goes into both buckets whole, and the vertex stage then clipped the instances outside each
//     band — after running every vertex of them. A 400k-triangle tree a metre past its band paid for
//     400k vertices to draw nothing. Here it is never appended.
//   - a frustum test of the instance's own bounding sphere: a 13 m cell half on screen no longer draws
//     its off-screen half.
//
// Survivors are appended to the bucket's vertex buffer of matrices (the instance layout the draw already
// reads), and `foliageCullArgs.wgsl` turns the count into indirect draw arguments. No readback: the CPU
// never learns how many survived, which is the point.
//
// Compute only, so no GLSL half (tools/wgslTranslate.mjs translates raster stages alone).

struct CullParams {
    // The camera frustum's six planes (Frustum.planes order), normalized; inside is >= 0.
    planes: array<vec4<f32>, 6>,
    // xyz = the camera position; w = 1 when this bucket has a crossfade band (u_lodCamera.w > 0.5).
    eye: vec4<f32>,
    // Fade-in start/end, fade-out start/end — u_lodBand.
    band: vec4<f32>,
    // The bucket's prototype bounding sphere in model space: xyz centre, w radius.
    sphere: vec4<f32>,
    // x = ranges, y = instances to test, z = this bucket's counter.
    counts: vec4<u32>,
};
@group(0) @binding(0) var<uniform> u_cull: CullParams;
// Every instance of the layer, cell by cell.
@group(0) @binding(1) var<storage, read> instances: array<mat4x4<f32>>;
// The bucket's cells: x = first instance, y = instances kept (the density prefix), z = exclusive prefix
// sum of y — where this cell's threads start.
@group(0) @binding(2) var<storage, read> ranges: array<vec4<u32>>;
@group(0) @binding(3) var<storage, read_write> visible: array<mat4x4<f32>>;
@group(0) @binding(4) var<storage, read_write> counters: array<atomic<u32>>;

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
    // Two dimensions, so a bucket past 65535 workgroups (4M instances) still dispatches.
    let t = gid.x + gid.y * groups.x * 64u;
    if (t >= u_cull.counts.y) { return; }

    // The cell holding thread t: the last range whose prefix is <= t.
    var lo = 0u;
    var hi = u_cull.counts.x;
    loop {
        if (hi - lo <= 1u) { break; }
        let mid = (lo + hi) / 2u;
        if (ranges[mid].z <= t) { lo = mid; } else { hi = mid; }
    }
    let r = ranges[lo];
    let m = instances[r.x + (t - r.z)];

    // The crossfade, as the vertex stage computes it: an instance faded fully out of this band draws nothing.
    if (u_cull.eye.w > 0.5) {
        let d = distance(m[3].xyz, u_cull.eye.xyz);
        let band = u_cull.band;
        let fadeIn = select(1.0, smoothstep(band.x, band.y, d), band.y > band.x);
        let fadeOut = select(1.0, 1.0 - smoothstep(band.z, band.w, d), band.w > band.z);
        if (min(fadeIn, fadeOut) <= 0.0) { return; }
    }

    // The instance's own bounding sphere against the frustum. Instances scale uniformly.
    let c = (m * vec4<f32>(u_cull.sphere.xyz, 1.0)).xyz;
    let radius = u_cull.sphere.w * length(m[1].xyz);
    for (var p = 0u; p < 6u; p++) {
        let plane = u_cull.planes[p];
        if (dot(plane.xyz, c) + plane.w < -radius) { return; }
    }

    let slot = atomicAdd(&counters[u_cull.counts.z], 1u);
    visible[slot] = m;
}

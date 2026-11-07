// Froxel volumetric fog (render/volumetricFog.ts), shared by its three passes.
//
// The camera's view, out to `u_far`, is cut into a W x H x N grid of froxels: W x H screen tiles, N slices
// spaced exponentially in view depth (Wronski 2014; Hillaire 2015). The grid is stored as a 2D ATLAS — the
// N slices laid out `u_grid.w` to a row — so every pass is a plain fullscreen draw into a 2D target on both
// backends: no 3D render target, no compute, the same code on WebGL2 and WebGPU.
//
//   inject     one fragment per froxel: the medium the fog volumes put there, lit by the sun or moon (with
//              its cascaded shadow), every clustered point and spot light, and the sky's ambient; blended
//              with last frame's froxel through the camera's motion. rgb = in-scattered + emitted light per
//              metre (pre-exposed), a = extinction per metre.
//   integrate  one fragment per froxel: front to back from the camera to the far edge of its slice, with
//              the energy-conserving step `S (1 - e^{-sigma d}) / sigma` (Hillaire 2015). rgb = light
//              scattered toward the camera, a = transmittance.
//   apply      one fragment per pixel: the integrated froxel at the pixel's depth, as `colour * T + S`.

struct FogUniforms {
    u_invViewProj: mat4x4<f32>,     // clip -> world, the frame's (as skyFog.wgsl reconstructs)
    u_prevViewProj: mat4x4<f32>,    // world -> last frame's clip (uv-producing, unjittered)
    u_prevView: mat4x4<f32>,        // world -> last frame's view
    u_camPos: vec3<f32>,
    u_near: f32,
    u_camForward: vec3<f32>,
    u_far: f32,
    /** W, H, N, slices per atlas row. */
    u_grid: vec4<f32>,
    u_renderSize: vec2<f32>,
    u_jitter: f32,                  // 0..1, this frame's offset within each froxel's depth
    u_historyWeight: f32,           // 0 = no history
    u_sunDir: vec3<f32>,            // unit, TOWARD the key light
    u_time: f32,
    u_sunColor: vec3<f32>,          // the key light's irradiance, pre-exposed
    u_volumeCount: i32,
    u_ambient: vec3<f32>,           // the fill's irradiance (scene ambient + sky light), pre-exposed
    u_historyRescale: f32,          // k_now / k_history
    u_localLights: i32,             // 1 = scatter the clustered point and spot lights
    u_emitterCount: i32,
    u_localShadows: i32,            // 1 = the point and spot lights' shadow maps shade what they scatter
    u_padding1: f32,
    u_volumeInv: array<mat4x4<f32>, 16>,   // world -> each volume's unit cube
    u_volumeA: array<vec4<f32>, 16>,       // density, anisotropy, height falloff, world height of the box
    u_volumeB: array<vec4<f32>, 16>,       // albedo rgb, noise strength
    u_volumeC: array<vec4<f32>, 16>,       // emission rgb (pre-exposed), noise scale
    u_volumeD: array<vec4<f32>, 16>,       // edge feather (unit-cube fractions) xyz, sun scattering
    u_volumeE: array<vec4<f32>, 16>,       // wind xyz (m/s), local-light scattering
    u_volumeF: array<vec4<f32>, 16>,       // ambient scattering, 0, 0, 0
    u_emitters: array<vec4<f32>, 16>,      // fog-only glow spheres: position xyz, radius
    u_emitterColor: array<vec4<f32>, 16>,  // their intensity rgb (pre-exposed), 0
};
@group(1) @binding(0) var<uniform> u_fogv: FogUniforms;

const FOG_PI: f32 = 3.14159265359;

/** View depth of slice coordinate `z` (0 = the near plane, N = the far one), exponential. */
fn fogSliceDepth(z: f32) -> f32 {
    return u_fogv.u_near * pow(u_fogv.u_far / u_fogv.u_near, z / u_fogv.u_grid.z);
}

/** The slice coordinate of view depth `d` (inverse of fogSliceDepth). */
fn fogDepthSlice(d: f32) -> f32 {
    return log(max(d, u_fogv.u_near) / u_fogv.u_near) / log(u_fogv.u_far / u_fogv.u_near) * u_fogv.u_grid.z;
}

/** The world point at screen `uv` and clip depth `depth` (as skyFog.wgsl). */
fn fogWorldAt(uv: vec2<f32>, depth: f32) -> vec3<f32> {
    let clip = vec4<f32>(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    let w = u_fogv.u_invViewProj * clip;
    return w.xyz / w.w;
}

/** The unit world direction of the view ray through screen `uv`. */
fn fogRayDir(uv: vec2<f32>) -> vec3<f32> {
    return normalize(fogWorldAt(uv, 1.0) - fogWorldAt(uv, 0.0));
}

/** Which froxel an atlas pixel holds: its tile (x, y) and slice. */
fn fogFroxelOf(atlasPx: vec2<f32>) -> vec3<i32> {
    let w = i32(u_fogv.u_grid.x);
    let h = i32(u_fogv.u_grid.y);
    let cols = i32(u_fogv.u_grid.w);
    let p = vec2<i32>(floor(atlasPx));
    let tile = vec2<i32>(p.x / w, p.y / h);
    return vec3<i32>(p.x - tile.x * w, p.y - tile.y * h, tile.y * cols + tile.x);
}

/** The atlas texel of froxel (x, y, slice). */
fn fogAtlasTexel(x: i32, y: i32, slice: i32) -> vec2<i32> {
    let w = i32(u_fogv.u_grid.x);
    let h = i32(u_fogv.u_grid.y);
    let cols = i32(u_fogv.u_grid.w);
    return vec2<i32>((slice % cols) * w + x, (slice / cols) * h + y);
}

/**
 * A froxel volume read at screen `uv` and slice coordinate `z` (texel centres at s + 0.5): bilinear within
 * a slice (inset half a texel so it never bleeds into the neighbouring slice's tile) and linear between
 * two slices. Explicit LOD, so it is legal anywhere.
 */
fn fogSampleAtlas(atlas: texture_2d<f32>, smp: sampler, uv: vec2<f32>, z: f32) -> vec4<f32> {
    let n = u_fogv.u_grid.z;
    let zc = clamp(z - 0.5, 0.0, n - 1.0);
    let s0 = floor(zc);
    let s1 = min(s0 + 1.0, n - 1.0);
    let f = zc - s0;
    let size = vec2<f32>(textureDimensions(atlas, 0));
    let grid = u_fogv.u_grid.xy;
    let local = clamp(uv * grid, vec2<f32>(0.5), grid - 0.5);
    let cols = u_fogv.u_grid.w;
    let t0 = vec2<f32>(s0 % cols, floor(s0 / cols)) * grid;
    let t1 = vec2<f32>(s1 % cols, floor(s1 / cols)) * grid;
    let a = textureSampleLevel(atlas, smp, (t0 + local) / size, 0.0);
    let b = textureSampleLevel(atlas, smp, (t1 + local) / size, 0.0);
    return mix(a, b, f);
}

// GI capture, step two: the six G-buffer faces of a batch of probes -> each probe's HIT CACHE tile
// (render/gi/giCapture.ts). Drawn over a volume's whole hit cache; texels of probes outside the batch are
// discarded, so earlier batches keep what they wrote.
//
// Each output texel is one RAY: its direction from the tile's octahedral map, the cube face its major
// axis lands on, and the texel of that face's tile in the capture atlas (6 faces across, one probe slot
// a row). Addresses are MEMORY texels (textureLoad), the same on both backends; only the row order inside
// a rendered tile differs (u_originTopLeft), because NDC +y is the top row on WebGPU and the bottom on GL.
//
// The back-face atlas holds, per ray, the nearest BACK face of what encloses the probe: a ray that meets
// one before any front face is a back-face hit — the probe stands inside something (giClassify.ts).

#include "./chunks/fullscreen.wgsl"
#include "./chunks/octNormal.wgsl"
#include "./chunks/giCommon.wgsl"

@group(0) @binding(0) var u_capAlbedo_texture: texture_2d<f32>;     // rgb albedo, a metallic (signed)
@group(0) @binding(1) var u_capAlbedo_sampler: sampler;
@group(0) @binding(2) var u_capNormal_texture: texture_2d<f32>;     // rg oct normal
@group(0) @binding(3) var u_capNormal_sampler: sampler;
@group(0) @binding(4) var u_capEmissive_texture: texture_2d<f32>;   // rgb emissive (absolute)
@group(0) @binding(5) var u_capEmissive_sampler: sampler;
@group(0) @binding(6) var u_capDepth_texture: texture_depth_2d;
@group(0) @binding(7) var u_capDepth_sampler: sampler;
@group(0) @binding(8) var u_capBack_texture: texture_depth_2d;       // back faces of what encloses the probe
@group(0) @binding(9) var u_capBack_sampler: sampler;

struct GiReduceUniforms {
    /** Rotation-only view x projection of each face, GL convention: +X, -X, +Y, -Y, +Z, -Z. */
    u_faceViewProj: array<mat4x4<f32>, 6>,
    /** Their inverses, for the hit distance. */
    u_faceInvViewProj: array<mat4x4<f32>, 6>,
    /** The batch: slot k's local probe index (x, y, z, w of entries 0 and 1), -1 when empty. */
    u_batch: array<vec4<i32>, 2>,
    u_maxRayDistance: f32,
    u_raySide: i32,
    u_captureSide: i32,
    u_originTopLeft: i32,
    u_hasBackfaces: i32,
    _pad0: i32,
    /** The capture atlas's size: depth is SAMPLED at texel centres (naga's GLSL cannot textureLoad a depth texture). */
    u_captureSize: vec2<f32>,
};
@group(1) @binding(0) var<uniform> u_reduce: GiReduceUniforms;

struct HitOut {
    @location(0) outHitA: vec4<f32>,
    @location(1) outHitB: vec4<f32>,
    @location(2) outHitC: vec4<f32>,
};

/** The cube face a direction's major axis lands on: 0 +X, 1 -X, 2 +Y, 3 -Y, 4 +Z, 5 -Z. */
fn giFaceOf(d: vec3<f32>) -> i32 {
    let a = abs(d);
    if (a.x >= a.y && a.x >= a.z) { return select(1, 0, d.x >= 0.0); }
    if (a.y >= a.z) { return select(3, 2, d.y >= 0.0); }
    return select(5, 4, d.z >= 0.0);
}

@fragment
fn fs_main(in: VertexOutput) -> HitOut {
    let side = u_reduce.u_raySide;
    let texel = vec2<i32>(floor(in.position.xy));
    let probe = (texel.y / side) * 64 + texel.x / side;

    var slot = -1;
    for (var k = 0; k < 8; k++) {
        if (u_reduce.u_batch[k / 4][k % 4] == probe) { slot = k; }
    }
    if (slot < 0) { discard; }

    let rayTexel = vec2<f32>(f32(texel.x % side), f32(texel.y % side));
    let d = giRayDirection(rayTexel, f32(side));
    let face = giFaceOf(d);

    // Where this ray lands on its face: the face's NDC, then the texel of the face's tile.
    let clip = u_reduce.u_faceViewProj[face] * vec4<f32>(d, 1.0);
    let ndc = clip.xy / clip.w;
    let S = u_reduce.u_captureSide;
    let col = clamp(i32(floor((ndc.x * 0.5 + 0.5) * f32(S))), 0, S - 1);
    var row = clamp(i32(floor((ndc.y * 0.5 + 0.5) * f32(S))), 0, S - 1);
    if (u_reduce.u_originTopLeft != 0) { row = S - 1 - row; }
    let at = vec2<i32>(face * S + col, slot * S + row);

    // The texel centre's own NDC, which its depth belongs to (not the ray's exact point on the face).
    var centreY = (f32(row) + 0.5) / f32(S);
    if (u_reduce.u_originTopLeft != 0) { centreY = 1.0 - centreY; }
    let centre = vec2<f32>((f32(col) + 0.5) / f32(S), centreY) * 2.0 - 1.0;

    let maxDistance = u_reduce.u_maxRayDistance;
    var out: HitOut;
    let atUv = (vec2<f32>(at) + vec2<f32>(0.5)) / u_reduce.u_captureSize;
    let depth = textureSampleLevel(u_capDepth_texture, u_capDepth_sampler, atUv, 0);
    var kind = 0;          // miss
    var distance = maxDistance;
    if (depth < 1.0) {
        let p = u_reduce.u_faceInvViewProj[face] * vec4<f32>(centre, depth * 2.0 - 1.0, 1.0);
        distance = length(p.xyz / p.w);
        kind = 2;
    }
    if (u_reduce.u_hasBackfaces != 0) {
        let back = textureSampleLevel(u_capBack_texture, u_capBack_sampler, atUv, 0);
        if (back < 1.0) {
            let q = u_reduce.u_faceInvViewProj[face] * vec4<f32>(centre, back * 2.0 - 1.0, 1.0);
            let backDistance = length(q.xyz / q.w);
            if (backDistance < distance - 0.02) { kind = 1; distance = backDistance; }
        }
    }
    if (distance >= maxDistance) { kind = 0; distance = maxDistance; }

    let albedoMetallic = textureLoad(u_capAlbedo_texture, at, 0);
    let normal = textureLoad(u_capNormal_texture, at, 0).rg;
    let emissive = textureLoad(u_capEmissive_texture, at, 0).rgb;
    // A metal has no diffuse; a translucent leaf stores -translucency where metallic goes.
    let diffuse = albedoMetallic.rgb * (1.0 - saturate(albedoMetallic.a));

    let alpha = select(select(0.0, GI_HIT_BACK, kind == 1), GI_HIT_FRONT, kind == 2);
    out.outHitA = vec4<f32>(select(vec3<f32>(0.0), sqrt(saturate(diffuse)), kind == 2), alpha);
    out.outHitB = vec4<f32>(select(vec2<f32>(0.5), normal * 0.5 + 0.5, kind == 2), giEncode16(distance / maxDistance));
    out.outHitC = select(vec4<f32>(0.0), giEncodeRGBE(max(emissive, vec3<f32>(0.0))), kind == 2);
    return out;
}

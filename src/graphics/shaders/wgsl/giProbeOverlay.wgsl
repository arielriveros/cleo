// Editor overlay: a GI Volume's probes as small spheres (render/gi/giSystem.ts `drawProbeOverlay`), drawn
// into the editor's overlay layer after the post chain, depth-tested against the scene.
//
// One instanced draw a volume and no instance buffer: instance i is the volume's probe i, walked so the
// spheres draw back to front (giLayout.ts `giProbeOfInstance`; the overlay never writes depth). An ACTIVE
// probe is shaded by its own irradiance along the sphere's normal — the light it holds, from where it
// comes — on an 18% grey card through the image's exposure and curve (the GI debug channel's conversion).
// An inactive probe (inside a wall, a rock) is small and red, one not captured yet small and grey; a probe
// under the ground is not drawn.
//
// Every uniform block is read by the vertex stage alone: GLSL ES 3.00 does not link a block read by both.
// What the fragment stage needs of them arrives as flat varyings.

#include "./chunks/octNormal.wgsl"
#include "./chunks/giCommon.wgsl"
#include "./chunks/giSample.wgsl"
#include "./chunks/grade.wgsl"

struct GiProbeOverlayUniforms {
    u_view: mat4x4<f32>,
    u_projection: mat4x4<f32>,
    /** x an active probe's radius (m), y any other's, z the volume's slot in u_giVolumes, w the tone mapper. */
    u_params: vec4<f32>,
    /** xyz 1 where that grid axis is walked from its high end (back to front), w unused. */
    u_flip: vec4<f32>,
};
@group(1) @binding(0) var<uniform> u_probes: GiProbeOverlayUniforms;

// A STRUCT return, so the GLSL translator names the vertex input after the layout (occlusionBox.wgsl).
struct ProbeVarying {
    @builtin(position) position: vec4<f32>,
    @location(0) normal: vec3<f32>,
    /** x the probe's state (giClassify.ts), y the display scale (intensity x exposure / store scale), z the tone mapper. */
    @location(1) @interpolate(flat) info: vec4<f32>,
    /** xy this probe's irradiance tile origin (texels), zw the atlas size. */
    @location(2) @interpolate(flat) tile: vec4<f32>,
};

@vertex
fn vs_main(@location(0) position: vec3<f32>, @builtin(instance_index) instance: u32) -> ProbeVarying {
    var out: ProbeVarying;
    let v = i32(u_probes.u_params.z);
    let counts = u_giVolumes.u_giCounts[v];
    let i = i32(instance);
    var x = i % counts.x;
    var y = (i / counts.x) % counts.y;
    var z = i / (counts.x * counts.y);
    if (u_probes.u_flip.x > 0.5) { x = counts.x - 1 - x; }
    if (u_probes.u_flip.y > 0.5) { y = counts.y - 1 - y; }
    if (u_probes.u_flip.z > 0.5) { z = counts.z - 1 - z; }
    let probe = counts.w + x + counts.x * (y + counts.y * z);
    let data = giProbeData(probe);
    let state = data.w;
    // Active full size, inactive / uncaptured / pending small, skipped (under the ground) not at all.
    var radius = u_probes.u_params.y;
    if (abs(state - 1.0) < 0.25) { radius = u_probes.u_params.x; }
    if (abs(state - 3.0) < 0.25) { radius = 0.0; }
    let centre = (u_giVolumes.u_giGridToWorld[v] * vec4<f32>(f32(x), f32(y), f32(z), 1.0)).xyz + data.xyz;
    out.position = u_probes.u_projection * u_probes.u_view * vec4<f32>(centre + position * radius, 1.0);
    out.normal = position;
    let perRow = i32(u_giVolumes.u_giAtlas.x);
    out.info = vec4<f32>(state, u_giVolumes.u_giBlend[v].w, u_probes.u_params.w, 0.0);
    out.tile = vec4<f32>(vec2<f32>(f32(probe % perRow), f32(probe / perRow)) * GI_IRR_TILE, u_giVolumes.u_giAtlasSize.xy);
    return out;
}

@fragment
fn fs_main(in: ProbeVarying) -> @location(0) vec4<f32> {
    // The other atlases and the probe data's sampler, read for nothing: a pipeline layout drops what the
    // shader never reaches, and the group binds them all (giAmbientCube's anchors).
    let anchor = (textureSampleLevel(u_giVisibility_texture, u_giVisibility_sampler, vec2<f32>(0.5), 0.0).a
                + textureSampleLevel(u_giProbeData_texture, u_giProbeData_sampler, vec2<f32>(0.5), 0.0).a) * 0.0;
    let state = in.info.x;
    if (abs(state - 1.0) >= 0.25) {
        // Inside geometry: red. Not captured yet (or awaiting its classification): grey.
        let c = select(vec3<f32>(0.45), vec3<f32>(0.9, 0.12, 0.1), abs(state - 2.0) < 0.25);
        return vec4<f32>(c + vec3<f32>(anchor), 1.0);
    }
    let N = normalize(in.normal);
    let local = (octEncode(N) * 0.5 + 0.5) * GI_IRR_INTERIOR + vec2<f32>(1.0);
    let e = textureSampleLevel(u_giIrradiance_texture, u_giIrradiance_sampler, (in.tile.xy + local) / in.tile.zw, 0.0).rgb;
    let display = toneCurve(e * in.info.y * 0.18, i32(in.info.z + 0.5));
    return vec4<f32>(display + vec3<f32>(anchor), 1.0);
}

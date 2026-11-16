// UNDERWATER: the view from inside a Water node's water (render/water.ts), over everything drawn so far,
// the water's own surface included. Each pixel's view ray is followed from the camera to what it hits; the
// part of it under the surface (a level plane at the camera's water height) is fogged and tinted by the
// water - Beer-Lambert absorption, in-scattered toward the underwater colour - and what lies under the
// surface catches the caustics the waves above focus on it.

#include "./chunks/fullscreen.wgsl"

@group(0) @binding(0) var u_sceneColor_texture: texture_2d<f32>;
@group(0) @binding(1) var u_sceneColor_sampler: sampler;
@group(0) @binding(2) var u_sceneDepth_texture: texture_depth_2d;
@group(0) @binding(3) var u_sceneDepth_sampler: sampler;

struct UnderwaterUniforms {
    u_invViewProj: mat4x4<f32>,   // clip -> world (uv-consuming form)
    u_camera: vec4<f32>,          // position, the surface's height over it
    u_fog: vec4<f32>,             // underwater colour x light (pre-exposed), fog per metre
    u_absorb: vec4<f32>,          // absorption per metre (rgb), time
    u_sun: vec4<f32>,             // toward the sun, caustics strength
    u_causticScale: vec4<f32>,    // metres between caustic lines, far distance (m)
};
@group(1) @binding(0) var<uniform> u_uw: UnderwaterUniforms;

fn unproject(uv: vec2<f32>, depth: f32) -> vec3<f32> {
    let w = u_uw.u_invViewProj * vec4<f32>(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    return w.xyz / w.w;
}

fn causticAt(p: vec2<f32>, t: f32) -> f32 {
    var c = 0.0;
    var q = p;
    for (var i = 0; i < 3; i++) {
        let fi = f32(i);
        let a = q + vec2<f32>(sin(q.y * 1.3 + t * (0.7 + fi * 0.2)), cos(q.x * 1.1 - t * (0.6 + fi * 0.25)));
        let v = abs(sin(a.x) * sin(a.y));
        c += pow(1.0 - v, 8.0);
        q = q * 1.7 + vec2<f32>(1.3, -0.7);
    }
    return c / 3.0;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let scene = textureSampleLevel(u_sceneColor_texture, u_sceneColor_sampler, in.uv, 0.0).rgb;
    let d = textureSampleLevel(u_sceneDepth_texture, u_sceneDepth_sampler, in.uv, 0);
    let cam = u_uw.u_camera.xyz;
    let level = u_uw.u_camera.w;
    let far = d >= 1.0;
    var p = unproject(in.uv, select(d, 0.9999, far));
    var dir = p - cam;
    var len = length(dir);
    dir = dir / max(len, 1e-5);
    if (far) { len = u_uw.u_causticScale.y; }
    // The stretch of the ray under the surface: all of it, unless it climbs out first.
    var path = len;
    if (dir.y > 1e-4) { path = min(len, max(0.0, (level - cam.y) / dir.y)); }
    let transmit = exp(-u_uw.u_absorb.rgb * path) * exp(-u_uw.u_fog.w * path);
    var lit = scene;
    // Caustics on what lies under the surface, as deep as the sun reaches.
    let hit = cam + dir * len;
    if (!far && hit.y < level && u_uw.u_sun.w > 0.0) {
        let depthBelow = level - hit.y;
        let c = causticAt(hit.xz / max(u_uw.u_causticScale.x, 0.05) * 2.0, u_uw.u_absorb.w * 0.8);
        lit = scene * (1.0 + c * u_uw.u_sun.w * 1.5 * max(u_uw.u_sun.y, 0.0) * exp(-u_uw.u_absorb.g * depthBelow));
    }
    let color = lit * transmit + u_uw.u_fog.rgb * (vec3<f32>(1.0) - transmit);
    return vec4<f32>(color, 1.0);
}

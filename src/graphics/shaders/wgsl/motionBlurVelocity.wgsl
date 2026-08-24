// Camera-reprojection velocity buffer: where each pixel's world point sat on screen last frame.

#include "./chunks/fullscreen.wgsl"

// device depth from the G-buffer
@group(0) @binding(0) var u_gDepth_texture: texture_depth_2d;
@group(0) @binding(1) var u_gDepth_sampler: sampler;

struct VelocityUniforms {
    u_invViewProj: mat4x4<f32>,   // this frame's inverse view-projection
    u_prevViewProj: mat4x4<f32>,  // previous frame's view-projection
    u_screenSize: vec2<f32>,      // full-res dimensions (px)
    u_intensity: f32,             // shutter-like blur scale
    u_maxVelocityPx: f32,         // clamp blur length to this many pixels
};
@group(1) @binding(0) var<uniform> u_mb: VelocityUniforms;

// Reconstruct world position from device depth (same primitive the deferred lighting pass uses).
fn reconstructWorldPos(uv: vec2<f32>, depth: f32) -> vec3<f32> {
    let clip = vec4<f32>(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    let world = u_mb.u_invViewProj * clip;
    return world.xyz / world.w;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // Reconstruct this pixel's world position. Background (no geometry, depth == 1.0) is treated as a
    // point on the far plane so the sky still blurs under camera rotation.
    let depth = min(textureSampleLevel(u_gDepth_texture, u_gDepth_sampler, in.uv, 0), 0.999999);
    let worldPos = reconstructWorldPos(in.uv, depth);

    // Where did this world point sit on screen last frame?
    let prevClip = u_mb.u_prevViewProj * vec4<f32>(worldPos, 1.0);
    let prevUV = (prevClip.xy / prevClip.w) * 0.5 + 0.5;

    // Screen-space motion vector in UV units.
    var velocity = (in.uv - prevUV) * u_mb.u_intensity;

    // Clamp the blur length (measured in pixels) so streaks never exceed one tile.
    let velPx = velocity * u_mb.u_screenSize;
    let lenPx = length(velPx);
    if (lenPx > u_mb.u_maxVelocityPx) {
        velocity *= u_mb.u_maxVelocityPx / max(lenPx, 1e-5);
    }

    return vec4<f32>(velocity, 0.0, 1.0);
}

// Camera-reprojection velocity buffer: where each pixel's world point sat on screen last frame.
//
// Writes the RAW delta in UV units — unscaled by the shutter and unclamped. See
// chunks/motionBlurShutter.wgsl for why the buffer stores the unblurred form and each consumer
// applies its own.

#include "./chunks/fullscreen.wgsl"

// device depth from the G-buffer
@group(0) @binding(0) var u_gDepth_texture: texture_depth_2d;
@group(0) @binding(1) var u_gDepth_sampler: sampler;

struct VelocityUniforms {
    // The inverse of what was actually RASTERIZED, TAA jitter included — it has to invert the matrix
    // the depth buffer was written through, or every reconstructed world point lands half a texel off
    // its own geometry.
    u_invViewProj: mat4x4<f32>,
    // UNJITTERED, both of them. The delta below is where a surface point sat on screen across two
    // frames, and a jitter appearing on one side of that subtraction and not the other is
    // indistinguishable from real motion.
    u_viewProj: mat4x4<f32>,
    u_prevViewProj: mat4x4<f32>,
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

    // Where this world point sits on screen this frame and last, both through UNJITTERED matrices.
    //
    // `curUV` rather than `in.uv`, which is what this used to subtract from. Under TAA the fragment's
    // own uv is the unjittered pixel centre while `worldPos` came back through the JITTERED inverse,
    // so their difference is exactly the jitter: every static pixel would report a half-pixel velocity
    // that flips sign each frame, and the resolve would spend forever chasing its own jitter. Going
    // back out through the unjittered projection cancels it algebraically instead — no jitter term
    // appears anywhere in this shader, which is also why its sign can never be wrong.
    let curClip = u_mb.u_viewProj * vec4<f32>(worldPos, 1.0);
    let prevClip = u_mb.u_prevViewProj * vec4<f32>(worldPos, 1.0);
    let curUV = (curClip.xy / curClip.w) * 0.5 + 0.5;
    let prevUV = (prevClip.xy / prevClip.w) * 0.5 + 0.5;

    // Screen-space motion vector in UV units. Raw: no shutter scale, no length clamp. `.w = 1` — this
    // IS the true screen delta, which only the per-object pass can contradict (see `encodeVelocity`).
    return vec4<f32>(curUV - prevUV, 0.0, 1.0);
}

// LIVE WAVES, step 1 (render/waterWaves.ts; the model and its reference are water/waveSim.ts): the waves are
// CARRIED by the current. Each texel takes the state of the water it now holds, from where that water was
// one step ago:
//
//     d(eta)/dt = -u . grad(eta) - eta (div u)
//
// (Jeschke and Wojtan 2023, eq. 14: surface waves transported through the bulk flow). The lookup is a
// Catmull-Rom cubic over sixteen texels: a linear one would smear a four-texel wave away in ten steps. The
// second term is why waves steepen where the current slows and flatten where it speeds up; as in the paper it
// is taken at a quarter of its strength where it amplifies, since nothing here lets a wave break and spend
// what it gains.
//
// The window follows the camera a whole texel at a time, so the state it leaves behind is read where it was.
//
// State: r the wave's height (m), g its rate (m/s), b the turbulence that stirs it (about -1..1, carried with
// the water), a the foam it carries (0..1).

#include "./chunks/fullscreen.wgsl"

@group(0) @binding(0) var u_state_texture: texture_2d<f32>;
@group(0) @binding(1) var u_state_sampler: sampler;
@group(0) @binding(2) var u_field_texture: texture_2d<f32>;   // current x, z (m/s), depth (m), baked foam
@group(0) @binding(3) var u_field_sampler: sampler;

struct AdvectUniforms {
    u_window: vec4<f32>,   // origin x, origin z (m), side (m), texels a side
    u_prev: vec4<f32>,     // the window's origin a step ago (x, z), the step (s), 1 = there is a state to carry
};
@group(1) @binding(0) var<uniform> u_wa: AdvectUniforms;

/** The state at texel `c` (whole numbers); level water outside the window. */
fn stateAt(c: vec2<f32>) -> vec4<f32> {
    let n = u_wa.u_window.w;
    if (c.x < 0.0 || c.y < 0.0 || c.x >= n || c.y >= n) { return vec4<f32>(0.0); }
    return textureSampleLevel(u_state_texture, u_state_sampler, (c + vec2<f32>(0.5)) / n, 0.0);
}

fn cubic(t: f32) -> vec4<f32> {
    let t2 = t * t;
    let t3 = t2 * t;
    return vec4<f32>(-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1.0, -1.5 * t3 + 2.0 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let n = u_wa.u_window.w;
    let cell = u_wa.u_window.z / n;
    let uv = in.position.xy / n;
    let field = textureSampleLevel(u_field_texture, u_field_sampler, uv, 0.0);
    if (field.z <= 0.0 || u_wa.u_prev.w < 0.5) { return vec4<f32>(0.0); }
    let dt = u_wa.u_prev.z;
    // Where this water was, in the texels of the state as it was left.
    let xz = u_wa.u_window.xy + uv * u_wa.u_window.z - field.xy * dt;
    let p = (xz - u_wa.u_prev.xy) / cell - vec2<f32>(0.5);
    let base = floor(p);
    let wx = cubic(p.x - base.x);
    let wz = cubic(p.y - base.y);
    var s = vec4<f32>(0.0);
    for (var j = 0; j < 4; j++) {
        var row = vec4<f32>(0.0);
        for (var i = 0; i < 4; i++) {
            row += stateAt(base + vec2<f32>(f32(i) - 1.0, f32(j) - 1.0)) * wx[i];
        }
        s += row * wz[j];
    }
    // Squeezed where the current converges, spread where it parts (a texel of the field either way).
    let d = 2.0 / n;
    let ux = textureSampleLevel(u_field_texture, u_field_sampler, uv + vec2<f32>(d, 0.0), 0.0).x
           - textureSampleLevel(u_field_texture, u_field_sampler, uv - vec2<f32>(d, 0.0), 0.0).x;
    let uz = textureSampleLevel(u_field_texture, u_field_sampler, uv + vec2<f32>(0.0, d), 0.0).y
           - textureSampleLevel(u_field_texture, u_field_sampler, uv - vec2<f32>(0.0, d), 0.0).y;
    let div = (ux + uz) / (4.0 * cell);
    let grow = clamp(exp(-dt * select(div, 0.25 * div, div < 0.0)), 0.9, 1.1);
    // A cubic overshoots: foam is never less than none.
    return vec4<f32>(s.x * grow, s.y * grow, s.z, max(s.w, 0.0));
}

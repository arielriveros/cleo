// What the particle simulation and the particle renderer agree on: the state layout, the LUT rows, and
// the random stream. Included by both, so neither can drift from the other.
//
// STATE LAYOUT — four RGBA32F textures, one texel per particle, slot i at (i % width, i / width):
//   p0 = position.xyz, age (seconds)
//   p1 = velocity.xyz, lifetime (seconds; <= 0 means the slot is dead)
//   p2 = rotation (rad), angular velocity (rad/s), size (m), seed (0..1, fixed for the particle's life)
//   p3 = initial colour, linear RGBA
// Textures rather than storage buffers on BOTH backends: WebGL2 has no storage buffers, and a texture
// written by a compute shader on WebGPU and by a fragment shader on WebGL2 is read identically by one
// vertex shader. Read with `textureLoad` only — never filtered — so RGBA32F needs no optional feature.
//
// The LUT is `PARTICLE_LUT_WIDTH` texels per row; the rows are `LUT_ROW` in src/particles/curves.ts.

const PARTICLE_LUT_WIDTH: i32 = 256;
const LUT_COLOR_OVER_LIFE: i32 = 0;
const LUT_SCALARS: i32 = 1;        // x size/life, y size/speed, z spin/life, w speed/life
const LUT_COLOR_BY_SPEED: i32 = 2;
const LUT_INIT_COLOR: i32 = 3;

struct Particle {
    age: f32,
    lifetime: f32,
    rotation: f32,
    spin: f32,
    size: f32,
    seed: f32,
    position: vec3<f32>,
    velocity: vec3<f32>,
    color: vec4<f32>,
};

fn particleTexel(index: u32, width: u32) -> vec2<i32> {
    return vec2<i32>(i32(index % width), i32(index / width));
}

// PCG hash (Jarzynski & Olano, "Hash Functions for GPU Rendering"). One multiply-xorshift round is
// enough to decorrelate neighbouring slots, which is all a particle's random stream needs.
fn pcgHash(v: u32) -> u32 {
    let state = v * 747796405u + 2891336453u;
    let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

// The next uniform float in [0, 1). 24 bits, so it is exact in f32 and identical on both backends.
fn particleRand(state: ptr<function, u32>) -> f32 {
    *state = pcgHash(*state);
    return f32(*state >> 8u) / 16777216.0;
}

fn hasFeature(mask: f32, bit: u32) -> bool {
    return (u32(mask) & bit) != 0u;
}

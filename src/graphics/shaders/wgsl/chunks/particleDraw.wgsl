// What the two particle renderers (billboards, meshes) share: the uniform blocks, the bindings, how a
// particle's look is derived from its state, and the fragment shading. Each renderer adds only its own
// vertex stage.
//
// Two uniform blocks, one per stage — a block read from both stages is a GLSL ES link error (see
// tests/glslProgramLinkability.test.ts).

#include "./particleCommon.wgsl"
#include "./particleLut.wgsl"

const DRAW_COLOR_LIFE: u32  = 1u;
const DRAW_SIZE_LIFE: u32   = 2u;
const DRAW_COLOR_SPEED: u32 = 4u;
const DRAW_SIZE_SPEED: u32  = 8u;
const DRAW_LOCAL: u32       = 16u;
const DRAW_SORTED: u32      = 32u;

struct ParticleDrawVertex {
    u_viewProj: mat4x4<f32>,      // the raster projection, backend clip convention
    u_emitter: mat4x4<f32>,       // simulation space -> world
    u_camRight: vec4<f32>,        // xyz, state texture width
    u_camUp: vec4<f32>,           // xyz, sort texture width
    u_camPos: vec4<f32>,          // xyz, alignment (0 camera, 1 velocity, 2 vertical, 3 horizontal)
    u_camForward: vec4<f32>,      // xyz, velocity stretch
    u_drawMask: vec4<f32>,        // feature bits, size scale, first live slot, capacity
    u_tint: vec4<f32>,
    u_flipbook: vec4<f32>,        // columns, rows, frames, mode (0 over life, 1 fps)
    u_flipbook2: vec4<f32>,       // fps, cycles, random start, frame blend
    u_speedRange: vec4<f32>,      // colour-by-speed min, max, size-by-speed min, max
};
@group(1) @binding(0) var<uniform> u_draw: ParticleDrawVertex;

struct ParticleDrawFragment {
    u_fragParams: vec4<f32>,      // blend (0 alpha, 1 additive, 2 cutout), cutoff, softness (m), brightness
    u_depthParams: vec4<f32>,     // near, far, orthographic, depth valid
    u_fragMask: vec4<f32>,        // has texture, lit, 1 / screen width, 1 / screen height
    u_ambient: vec4<f32>,         // lit: ambient rgb; w = 1 for a mesh (no procedural disc)
    u_sunDir: vec4<f32>,          // lit: direction TO the sun, xyz
    u_sunColor: vec4<f32>,        // lit: sun radiance rgb
};
@group(1) @binding(1) var<uniform> u_frag: ParticleDrawFragment;

@group(0) @binding(0) var u_p0_texture: texture_2d<f32>;
@group(0) @binding(1) var u_p1_texture: texture_2d<f32>;
@group(0) @binding(2) var u_p2_texture: texture_2d<f32>;
@group(0) @binding(3) var u_p3_texture: texture_2d<f32>;
@group(0) @binding(4) var u_lut_texture: texture_2d<f32>;
@group(0) @binding(5) var u_sprite_texture: texture_2d<f32>;
@group(0) @binding(6) var u_sprite_sampler: sampler;
@group(0) @binding(7) var u_sceneDepth_texture: texture_depth_2d;
@group(0) @binding(8) var u_sceneDepth_sampler: sampler;
// Back-to-front slot order, written by the sort (particleSort*.wgsl): (key, slot). Read only when sorted.
@group(0) @binding(9) var u_order_texture: texture_2d<f32>;

struct ParticleVaryings {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) uvNext: vec2<f32>,
    @location(2) color: vec4<f32>,
    @location(3) frameBlend: f32,
    @location(4) viewDepth: f32,
    @location(5) normal: vec3<f32>,
};

/** A particle, as the renderers see it: world space, with every over-life and by-speed module applied. */
struct ParticleLook {
    alive: bool,
    center: vec3<f32>,
    velocity: vec3<f32>,
    speed: f32,
    size: f32,
    color: vec4<f32>,
    life: f32,
    age: f32,
    rotation: f32,
    seed: f32,
};

fn deadVaryings() -> ParticleVaryings {
    var out: ParticleVaryings;
    // Every vertex on the same point outside the clip volume: no fragments, no NaNs.
    out.position = vec4<f32>(2.0, 2.0, 2.0, 1.0);
    out.uv = vec2<f32>(0.0);
    out.uvNext = vec2<f32>(0.0);
    out.color = vec4<f32>(0.0);
    out.frameBlend = 0.0;
    out.viewDepth = 0.0;
    out.normal = vec3<f32>(0.0, 1.0, 0.0);
    return out;
}

fn particleLook(instanceIndex: u32) -> ParticleLook {
    var look: ParticleLook;
    let mask = u_draw.u_drawMask.x;
    // Instances cover only the live window, which starts at slot `u_drawMask.z` and wraps round the
    // ring. A sorted emitter draws its whole pool through the order texture instead (z is 0 then).
    var slot = (instanceIndex + u32(u_draw.u_drawMask.z)) % max(1u, u32(u_draw.u_drawMask.w));
    if (hasFeature(mask, DRAW_SORTED)) {
        let order = textureLoad(u_order_texture, particleTexel(instanceIndex, u32(u_draw.u_camUp.w)), 0);
        slot = u32(order.y);
    }
    let texel = particleTexel(slot, u32(u_draw.u_camRight.w));
    let s0 = textureLoad(u_p0_texture, texel, 0);
    let s1 = textureLoad(u_p1_texture, texel, 0);
    look.alive = s1.w > 0.0;
    if (!look.alive) { return look; }
    let s2 = textureLoad(u_p2_texture, texel, 0);
    let s3 = textureLoad(u_p3_texture, texel, 0);

    look.life = clamp(s0.w / s1.w, 0.0, 1.0);
    look.age = s0.w;
    look.rotation = s2.x;
    look.seed = fract(s2.w);   // the collision flag rides on the seed for one step; see particleSimCore
    look.center = s0.xyz;
    look.velocity = s1.xyz;
    if (hasFeature(mask, DRAW_LOCAL)) {
        look.center = (u_draw.u_emitter * vec4<f32>(look.center, 1.0)).xyz;
        look.velocity = (u_draw.u_emitter * vec4<f32>(look.velocity, 0.0)).xyz;
    }
    look.speed = length(look.velocity);

    look.size = s2.z * u_draw.u_drawMask.y;
    if (hasFeature(mask, DRAW_SIZE_LIFE)) { look.size = look.size * particleLut(LUT_SCALARS, look.life).x; }
    if (hasFeature(mask, DRAW_SIZE_SPEED)) {
        let t = (look.speed - u_draw.u_speedRange.z) / max(1e-4, u_draw.u_speedRange.w - u_draw.u_speedRange.z);
        look.size = look.size * particleLut(LUT_SCALARS, t).y;
    }
    look.color = s3 * u_draw.u_tint;
    if (hasFeature(mask, DRAW_COLOR_LIFE)) { look.color = look.color * particleLut(LUT_COLOR_OVER_LIFE, look.life); }
    if (hasFeature(mask, DRAW_COLOR_SPEED)) {
        let t = (look.speed - u_draw.u_speedRange.x) / max(1e-4, u_draw.u_speedRange.y - u_draw.u_speedRange.x);
        look.color = look.color * particleLut(LUT_COLOR_BY_SPEED, t);
    }
    return look;
}

fn flipbookUv(frame: f32, uv: vec2<f32>) -> vec2<f32> {
    let columns = max(1.0, u_draw.u_flipbook.x);
    let rows = max(1.0, u_draw.u_flipbook.y);
    let column = frame - floor(frame / columns) * columns;
    let row = floor(frame / columns);
    // Atlas row 0 is the image's TOP, which an uploaded (flipped) texture holds at v = 1.
    return vec2<f32>((column + uv.x) / columns, (rows - row - 1.0 + uv.y) / rows);
}

/** Flipbook frame uvs for `uv` (0..1 over the sprite or mesh chart), written into `out`. */
fn applyFlipbook(out: ptr<function, ParticleVaryings>, look: ParticleLook, uv: vec2<f32>) {
    let frames = max(1.0, u_draw.u_flipbook.z);
    var f = select(look.life * frames * max(u_draw.u_flipbook2.y, 1e-3), look.age * u_draw.u_flipbook2.x,
                   u_draw.u_flipbook.w > 0.5);
    if (u_draw.u_flipbook2.z > 0.5) { f = f + floor(look.seed * frames); }
    let frame0 = f - floor(f / frames) * frames;
    let whole = floor(frame0);
    let next = select(whole + 1.0, 0.0, whole + 1.0 >= frames);
    (*out).uv = flipbookUv(whole, uv);
    (*out).uvNext = flipbookUv(next, uv);
    (*out).frameBlend = select(0.0, frame0 - whole, u_draw.u_flipbook2.w > 0.5);
}

// View depth from a depth-buffer value: the distance along the camera axis the vertex stage measured.
fn linearSceneDepth(d: f32) -> f32 {
    let near = u_frag.u_depthParams.x;
    let far = u_frag.u_depthParams.y;
    if (u_frag.u_depthParams.z > 0.5) { return near + d * (far - near); }
    let z = d * 2.0 - 1.0;
    return 2.0 * near * far / (far + near - z * (far - near));
}

fn shadeParticle(in: ParticleVaryings) -> vec4<f32> {
    var color = in.color;
    if (u_frag.u_fragMask.x > 0.5) {
        let a = textureSample(u_sprite_texture, u_sprite_sampler, in.uv);
        let b = textureSample(u_sprite_texture, u_sprite_sampler, in.uvNext);
        color = color * mix(a, b, in.frameBlend);
    } else if (u_frag.u_ambient.w < 0.5) {
        // A billboard with no texture: a soft round puff, so a fresh emitter reads as particles rather
        // than squares.
        let r = length(in.uv * 2.0 - 1.0);
        let falloff = clamp(1.0 - r * r, 0.0, 1.0);
        color.a = color.a * falloff * falloff;
    }

    let blend = i32(u_frag.u_fragParams.x);
    if (blend == 2 && color.a < u_frag.u_fragParams.y) { discard; }
    // Fully transparent texels — a round puff's corners, a sprite's empty border — would blend nothing but
    // still pay the soft-particle depth fetch and the blend. Fill rate is the whole cost of big particles.
    if (blend != 2 && color.a < 1.0 / 512.0) { discard; }

    // Soft particles: fade out as the surface nears the opaque geometry behind it, instead of clipping
    // into it along a hard line.
    let softness = u_frag.u_fragParams.z;
    if (softness > 0.0 && u_frag.u_depthParams.w > 0.5) {
        let uv = in.position.xy * u_frag.u_fragMask.zw;
        let scene = linearSceneDepth(textureSampleLevel(u_sceneDepth_texture, u_sceneDepth_sampler, uv, 0));
        color.a = color.a * clamp((scene - in.viewDepth) / softness, 0.0, 1.0);
    }

    var rgb = color.rgb * u_frag.u_fragParams.w;
    if (u_frag.u_fragMask.y > 0.5) {
        // Lit: a half-Lambert sun over sky ambient — particles are thin and back-lit as often as not,
        // so a hard Lambert term would leave half of every cloud black.
        let n = normalize(in.normal);
        let wrap = dot(n, u_frag.u_sunDir.xyz) * 0.5 + 0.5;
        rgb = rgb * (u_frag.u_ambient.rgb + u_frag.u_sunColor.rgb * wrap);
    }

    // Premultiplied out. Alpha blends `one, one-minus-src-alpha`; additive drops the alpha term; cutout
    // is opaque. The scene buffer's own alpha is the bloom mask and the pipelines leave it alone.
    if (blend == 1) { return vec4<f32>(rgb * color.a, 0.0); }
    if (blend == 2) { return vec4<f32>(rgb, 1.0); }
    return vec4<f32>(rgb * color.a, color.a);
}

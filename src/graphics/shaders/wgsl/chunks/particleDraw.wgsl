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
    u_stretchRange: vec4<f32>,    // velocity stretch multiplier: min, max (random per particle), 0, 0
};
@group(1) @binding(0) var<uniform> u_draw: ParticleDrawVertex;

struct ParticleDrawFragment {
    u_fragParams: vec4<f32>,      // blend (0 alpha, 1 additive, 2 cutout), cutoff, softness (m), brightness
    u_depthParams: vec4<f32>,     // near, far, orthographic, depth valid
    u_fragMask: vec4<f32>,        // has texture, lit, 1 / screen width, 1 / screen height
    u_ambient: vec4<f32>,         // lit: ambient rgb; w = 1 for a mesh (no procedural disc)
    u_sunDir: vec4<f32>,          // lit: direction TO the sun, xyz; w = near fade (m, 0 off), lit or not
    u_sunColor: vec4<f32>,        // lit: key light (sun, or the moon at night) irradiance rgb; w = translucency
    u_keyDir: vec4<f32>,          // lit: direction TO the strongest point / spot light reaching the effect
    u_keyColor: vec4<f32>,        // lit: that light's irradiance rgb (zero when none reaches); w = pre-exposure
    u_surface: vec4<f32>,         // lit: roughness, metallic, normal strength, SURFACE_* bits
    u_viewPos: vec4<f32>,         // lit: camera xyz; w = reflections: 0 the ambient, 1 sRGB cube, 2 linear cube
};
@group(1) @binding(1) var<uniform> u_frag: ParticleDrawFragment;

// `u_surface.w` bits. PBR: a highlight and metallic at all (any map, or a factor off its default) --
// without it a lit emitter shades as it always has, half-Lambert and no highlight.
const SURFACE_NORMAL_MAP: u32 = 1u;
const SURFACE_ORM_MAP: u32    = 2u;
const SURFACE_PBR: u32        = 4u;
const PARTICLE_PI: f32 = 3.14159265;
/** The env cube's mip at roughness 1, as pbrForward's MAX_REFLECTION_LOD. */
const PARTICLE_REFLECTION_LOD: f32 = 4.0;

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
// Lit emitters' surface: a tangent-space normal map and an ORM map, cut into the sprite's flipbook cells
// (white 1x1 when absent), and the reflection cube (the probe or sky the forward path reflects).
@group(0) @binding(10) var u_normalMap_texture: texture_2d<f32>;
@group(0) @binding(11) var u_normalMap_sampler: sampler;
@group(0) @binding(12) var u_ormMap_texture: texture_2d<f32>;
@group(0) @binding(13) var u_ormMap_sampler: sampler;
@group(0) @binding(14) var u_particleEnv_texture: texture_cube<f32>;
@group(0) @binding(15) var u_particleEnv_sampler: sampler;

struct ParticleVaryings {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) uvNext: vec2<f32>,
    @location(2) color: vec4<f32>,
    @location(3) frameBlend: f32,
    @location(4) viewDepth: f32,
    @location(5) normal: vec3<f32>,
    // World position, for the view vector and the normal map's frame (from its screen derivatives).
    @location(6) worldPos: vec3<f32>,
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
    out.worldPos = vec3<f32>(0.0);
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

/** GGX x Smith x Schlick, times N.L: a light's highlight per unit of its irradiance (liquidRender.ts `ggxSpecular`). */
fn particleSpecular(n: vec3<f32>, v: vec3<f32>, l: vec3<f32>, roughness: f32, f0: vec3<f32>) -> vec3<f32> {
    let nl = dot(n, l);
    if (nl <= 0.0) { return vec3<f32>(0.0); }
    let nv = max(dot(n, v), 1e-4);
    let h = normalize(v + l);
    let nh = max(dot(n, h), 0.0);
    let vh = max(dot(v, h), 0.0);
    let a = max(roughness * roughness, 0.002);
    let a2 = a * a;
    let dd = nh * nh * (a2 - 1.0) + 1.0;
    let D = a2 / (PARTICLE_PI * dd * dd);
    let k = a * 0.5;
    let G = (nl / (nl * (1.0 - k) + k)) * (nv / (nv * (1.0 - k) + k));
    let F = f0 + (vec3<f32>(1.0) - f0) * pow(1.0 - vh, 5.0);
    return F * (D * G / (4.0 * nv));
}

/** Karis' split-sum DFG fit, as pbrLighting.wgsl `EnvBRDFApprox`: the reflection's energy is f0 x A + B. */
fn particleEnvBrdf(nv: f32, roughness: f32) -> vec2<f32> {
    let c0 = vec4<f32>(-1.0, -0.0275, -0.572, 0.022);
    let c1 = vec4<f32>(1.0, 0.0425, 1.04, -0.04);
    let r = roughness * c0 + c1;
    let a004 = min(r.x * r.x, exp2(-9.28 * nv)) * r.x + r.y;
    return vec2<f32>(-1.04, 1.04) * a004 + r.zw;
}

/**
 * The normal map's tangent-space vector `t` onto the surface with normal `n`: the frame is the gradient of
 * the texture coordinates over the surface (Schuler 2013, "Normal Mapping without Precomputed Tangents"),
 * from screen derivatives, signed by its determinant so neither the card's facing nor the backend's screen
 * y direction can mirror it. +v is the image's up (uploads are flipped; see flipbookUv).
 */
fn particleMappedNormal(n: vec3<f32>, t: vec3<f32>, dpx: vec3<f32>, dpy: vec3<f32>, duvx: vec2<f32>, duvy: vec2<f32>) -> vec3<f32> {
    let dp2perp = cross(dpy, n);
    let dp1perp = cross(n, dpx);
    let det = dot(dpx, dp2perp);
    if (abs(det) < 1e-20) { return n; }
    let s = sign(det);
    let T = (dp2perp * duvx.x + dp1perp * duvy.x) * s;
    let B = (dp2perp * duvx.y + dp1perp * duvy.y) * s;
    let invmax = inverseSqrt(max(max(dot(T, T), dot(B, B)), 1e-30));
    return normalize(T * (invmax * t.x) + B * (invmax * t.y) + n * t.z);
}

/**
 * Light passing THROUGH a thin particle (a raindrop, a flake) and leaving its unlit side: the same model
 * as a leaf, `thinTransmission` in chunks/pbrLighting.wgsl. A small Lambert leak about -n plus a forward
 * lobe about the light as seen from the camera, so it glows when looked through toward the light and is
 * faint from the side. Additive on top of the front face; tinted by the particle's own colour `c`.
 */
fn particleTransmission(n: vec3<f32>, v: vec3<f32>, l: vec3<f32>, c: vec3<f32>, t: f32) -> vec3<f32> {
    let back = clamp(-dot(n, l), 0.0, 1.0);
    let lobe = pow(clamp(dot(-v, l), 0.0, 1.0), 6.0);
    let glow = 0.2 * back + 3.0 * lobe * (0.35 + 0.65 * back);
    return c * (t * glow / PARTICLE_PI);
}

fn shadeParticle(in: ParticleVaryings) -> vec4<f32> {
    // Everything with an implicit or explicit derivative comes first, in uniform control flow (before any
    // discard): the sprite, the surface maps, and the frame the normal map needs.
    let dpx = dpdx(in.worldPos);
    let dpy = dpdy(in.worldPos);
    let duvx = dpdx(in.uv);
    let duvy = dpdy(in.uv);
    let normalTexel = mix(textureSample(u_normalMap_texture, u_normalMap_sampler, in.uv),
                          textureSample(u_normalMap_texture, u_normalMap_sampler, in.uvNext), in.frameBlend);
    let ormTexel = mix(textureSample(u_ormMap_texture, u_ormMap_sampler, in.uv),
                       textureSample(u_ormMap_texture, u_ormMap_sampler, in.uvNext), in.frameBlend);
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

    // Near fade: gone by the lens, so a drop or a mote passing the camera never fills the view.
    let nearFade = u_frag.u_sunDir.w;
    if (nearFade > 0.0) { color.a = color.a * smoothstep(0.0, nearFade, in.viewDepth); }

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
    let surface = u_frag.u_surface;
    let flags = u32(surface.w + 0.5);
    if (u_frag.u_fragMask.y > 0.5 && (flags & SURFACE_PBR) == 0u) {
        // Lit: the scene's light, as surfaces take it — the ambient and sky fill, then the key light and the
        // strongest local light through the diffuse 1/π. Half-Lambert rather than Lambert: particles are
        // thin and back-lit as often as not, so a hard term would leave half of every cloud black.
        let n = normalize(in.normal);
        let sunWrap = dot(n, u_frag.u_sunDir.xyz) * 0.5 + 0.5;
        let keyWrap = dot(n, u_frag.u_keyDir.xyz) * 0.5 + 0.5;
        let direct = (u_frag.u_sunColor.rgb * sunWrap + u_frag.u_keyColor.rgb * keyWrap) * 0.31830988618; // 1 / PI
        let base = rgb;
        rgb = rgb * (u_frag.u_ambient.rgb + direct);
        // Translucency: the sun and the key light through the particle (a drop lit from behind glows).
        let translucency = u_frag.u_sunColor.w;
        if (translucency > 0.0) {
            let view = normalize(u_frag.u_viewPos.xyz - in.worldPos);
            rgb += u_frag.u_sunColor.rgb * particleTransmission(n, view, u_frag.u_sunDir.xyz, base, translucency)
                 + u_frag.u_keyColor.rgb * particleTransmission(n, view, u_frag.u_keyDir.xyz, base, translucency);
        }
    } else if (u_frag.u_fragMask.y > 0.5) {
        // Lit with a surface: a normal map, roughness and metallic, shaded as the forward PBR path shades
        // (GGX highlights from the key and local light, the probe or sky reflected, metals tinting both).
        let V = normalize(u_frag.u_viewPos.xyz - in.worldPos);
        var n = normalize(in.normal);
        // A card is seen from both sides: light the side facing the viewer.
        if (dot(n, V) < 0.0) { n = -n; }
        var occlusion = 1.0;
        var roughness = surface.x;
        var metallic = surface.y;
        if ((flags & SURFACE_ORM_MAP) != 0u) {
            occlusion = ormTexel.r;
            roughness = roughness * ormTexel.g;
            metallic = metallic * ormTexel.b;
        }
        roughness = clamp(roughness, 0.02, 1.0);
        metallic = clamp(metallic, 0.0, 1.0);
        // Half-Lambert on the flat card, as above; Lambert once a normal map gives it real relief.
        var wrap = 1.0;
        if ((flags & SURFACE_NORMAL_MAP) != 0u) {
            var t = normalTexel.xyz * 2.0 - 1.0;
            t = vec3<f32>(t.xy * surface.z, max(t.z, 1e-3));
            n = particleMappedNormal(n, normalize(t), dpx, dpy, duvx, duvy);
            wrap = 0.0;
        }
        let nv = max(dot(n, V), 1e-4);
        let f0 = mix(vec3<f32>(0.04), rgb, metallic);
        let sunL = u_frag.u_sunDir.xyz;
        let keyL = u_frag.u_keyDir.xyz;
        let sunD = max((dot(n, sunL) + wrap) / (1.0 + wrap), 0.0);
        let keyD = max((dot(n, keyL) + wrap) / (1.0 + wrap), 0.0);
        let direct = (u_frag.u_sunColor.rgb * sunD + u_frag.u_keyColor.rgb * keyD) / PARTICLE_PI;
        let diffuse = rgb * (1.0 - metallic) * (u_frag.u_ambient.rgb * occlusion + direct);
        let highlight = u_frag.u_sunColor.rgb * particleSpecular(n, V, sunL, roughness, f0)
                      + u_frag.u_keyColor.rgb * particleSpecular(n, V, keyL, roughness, f0);
        // What it reflects: the cube, blurred by roughness and fading toward the ambient as it roughens
        // (a box-filtered mip chain is no GGX prefilter). With no cube, the ambient as a sky over a darker
        // ground, so a mirror still shows which way is up.
        let R = reflect(-V, n);
        var env = u_frag.u_ambient.rgb * mix(0.35, 1.3, smoothstep(-0.25, 0.25, R.y));
        if (u_frag.u_viewPos.w > 0.5) {
            let c = textureSampleLevel(u_particleEnv_texture, u_particleEnv_sampler, R, roughness * PARTICLE_REFLECTION_LOD).rgb;
            let cube = select(pow(c, vec3<f32>(2.2)), c, u_frag.u_viewPos.w > 1.5);
            env = mix(env, cube, pow(1.0 - roughness, 4.0));
        }
        let dfg = particleEnvBrdf(nv, roughness);
        let reflection = env * (f0 * dfg.x + dfg.y) * occlusion;
        rgb = diffuse + highlight + reflection;
        let translucency = u_frag.u_sunColor.w;
        if (translucency > 0.0) {
            let glow = color.rgb * u_frag.u_fragParams.w;
            rgb += u_frag.u_sunColor.rgb * particleTransmission(n, V, sunL, glow, translucency)
                 + u_frag.u_keyColor.rgb * particleTransmission(n, V, keyL, glow, translucency);
        }
    }

    // Stored pre-exposed like every source (graphics/preExposure.ts); 0 — a host that never set it —
    // reads as 1. Below the half-float ceiling.
    let preExposure = select(1.0, u_frag.u_keyColor.w, u_frag.u_keyColor.w > 0.0);
    rgb = min(rgb * preExposure, vec3<f32>(32768.0));

    // Premultiplied out. Alpha blends `one, one-minus-src-alpha`; additive drops the alpha term; cutout
    // is opaque. The scene buffer's own alpha is the bloom mask and the pipelines leave it alone.
    if (blend == 1) { return vec4<f32>(rgb * color.a, 0.0); }
    if (blend == 2) { return vec4<f32>(rgb, 1.0); }
    return vec4<f32>(rgb * color.a, color.a);
}

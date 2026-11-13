// Lit sprite program (Sprite.lit): a camera-facing quad that takes the scene's light from its tileset's
// LIGHTING MAPS (Tileset.lighting) instead of showing its texture as it is.
//
//   mode 1  SIX-WAY LIGHTMAPS (smoke, steam, dust). The FX Creator renders each flipbook frame six more
//           times, lit from the frame's right, top and back and from its left, bottom and front, into two
//           atlases (positive: R right, G top, B back, A coverage; negative: R left, G bottom, B front,
//           A emission). Here each light's direction, in the sprite's own frame, picks and blends three of
//           the six by the squares of its components (they sum to 1), which is Unity VFX Graph's six-way
//           lighting and what EmberGen and Houdini export for: self-shadowing, back-lit glow and thick
//           cores, all baked, relit from any direction at the cost of two texture reads.
//   mode 2  SURFACE MAPS (liquids). The texture is the base colour; a tangent-space normal map (OpenGL)
//           and an ORM map shade it as a surface: diffuse plus GGX highlights.
//   mode 0  FLAT: half-Lambert on a card facing the camera, as a lit particle.
//
// Lights, as lit particles take them (render/particlePasses.ts): the key directional light (the sun, or
// the moon) with the cascaded shadow it casts on the sprite's quad and the cloud shadow, the ambient and
// sky fill, and the strongest local light near the sprite as a second key (the rest folded into the fill).
// The lit colour is scene-linear, like a model's: it takes the camera's whole exposure. Only the six-way
// EMISSION (a fire inside its smoke) is scaled by the sprite's intensity (overdrive, exposure weight).
//
// BATCHED (render/sprites2d.ts): one draw holds every lit sprite that shares the tileset's maps. Each
// instance's record (objectData.ts `packSpriteRecord`) carries its tint, opacity, intensity, soft fade and
// fill; its frame and light radius come from its own matrix. The block holds what the batch shares.

#include "./chunks/dither.wgsl"
#include "./chunks/objectData.wgsl"
#include "./chunks/tonemap.wgsl"
#include "./chunks/shadows.wgsl"
// The clustered lights: every point and spot light reaching the pixel, not one CPU-picked key per sprite.
// pbrLighting first, for the SpotLight struct and the falloff the surfaces use.
#include "./chunks/pbrLighting.wgsl"
#include "./chunks/clusteredLights.wgsl"

const SPRITE_PI: f32 = 3.14159265359;

struct SpriteLitVaryings {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    // Despawn dissolve (x = how far gone, y = dither phase); zero keeps everything. See dissolveKeeps.
    @location(1) dissolve: vec2<f32>,
    @location(2) worldPos: vec3<f32>,
    // The positive distance in front of the camera: the cascade pick.
    @location(3) viewDepth: f32,
    // The instance, the same for the whole quad: (tint r, g, b as authored, opacity) ...
    @location(4) @interpolate(flat) look: vec4<f32>,
    // ... (intensity, fill r, g, b) ...
    @location(5) @interpolate(flat) extra: vec4<f32>,
    // ... its right and up, unit (the matrix's first two columns), and its centre ...
    @location(6) @interpolate(flat) right: vec3<f32>,
    @location(7) @interpolate(flat) up: vec3<f32>,
    @location(8) @interpolate(flat) centre: vec3<f32>,
    // ... and (light radius, soft fade in metres).
    @location(9) @interpolate(flat) params: vec2<f32>,
};

// The same block the Basic program reads (chunks/basicVertex.wgsl), so the 2D pass's uploads land alike.
struct BasicTransform {
    u_view: mat4x4<f32>,
    u_projection: mat4x4<f32>,
    u_ditherPhase: f32,
};
@group(1) @binding(0) var<uniform> u_transform: BasicTransform;

@vertex
fn vs_main(
    @location(0) position: vec3<f32>,
    @location(1) texCoord: vec2<f32>,
    @builtin(instance_index) objectIndex: u32,
) -> SpriteLitVaryings {
    let model = objectModel(objectIndex);
    let uvt = objectUvTransform(objectIndex);
    let params = objectParams(objectIndex);
    let world = model * vec4<f32>(position, 1.0);
    let view = u_transform.u_view * world;
    var out: SpriteLitVaryings;
    out.uv = texCoord * uvt.xy + uvt.zw;
    out.dissolve = vec2<f32>(params.x, u_transform.u_ditherPhase);
    out.look = objectSpriteLook(objectIndex);
    out.extra = objectSpriteExtra(objectIndex);
    out.right = normalize(model[0].xyz);
    out.up = normalize(model[1].xyz);
    out.centre = model[3].xyz;
    // Half the placed quad's smaller world extent (render/sprites2d.ts `spriteLightRadius`): see `lightRadius`.
    out.params = vec2<f32>(0.5 * min(length(model[0].xyz), length(model[1].xyz)), params.w);
    out.worldPos = world.xyz;
    out.viewDepth = -view.z;
    out.position = u_transform.u_projection * view;
    return out;
}

@group(0) @binding(0) var u_material_texture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_material_texture_sampler: sampler;
// Six-way positive map, or the normal map.
@group(0) @binding(2) var u_material_mapA_texture: texture_2d<f32>;
@group(0) @binding(3) var u_material_mapA_sampler: sampler;
// Six-way negative map, or the ORM map.
@group(0) @binding(4) var u_material_mapB_texture: texture_2d<f32>;
@group(0) @binding(5) var u_material_mapB_sampler: sampler;
// The opaque scene's depth snapshot, for the soft fade (as chunks/basicForward.wgsl).
@group(0) @binding(6) var u_sceneDepth_texture: texture_depth_2d;
@group(0) @binding(7) var u_sceneDepth_sampler: sampler;

struct SpriteLitMaterial {
    // i32 rather than bool: WGSL forbids bool in a uniform buffer.
    hasTexture: i32,
    /** 0 flat, 1 six-way, 2 surface. */
    mode: i32,
    /** x near, y far, z 1 = orthographic, w 1 = the depth snapshot is live. */
    depthParams: vec4<f32>,
    /** Unit direction TOWARD the key directional light; its colour times its intensity. */
    sunDir: vec3<f32>,
    hasOrm: i32,
    sunColor: vec3<f32>,
    /**
     * The strongest local light at the sprite, off the cluster grid (a batch of one there): unit direction
     * toward it, and its colour at the sprite. Zero colour on the grid.
     */
    keyDir: vec3<f32>,
    keyColor: vec3<f32>,
    /** The camera (MaterialBinder sets it on every material). */
    viewPos: vec3<f32>,
    /** The draw's pre-exposure (FrameView.drawPreExposure); the lights above are absolute. 0 reads as 1. */
    preExposure: f32,
    /**
     * 1 when the frame's clustered light grid is bound: every local light is then evaluated per pixel
     * (`localLights`) and `keyColor` / the local share of each sprite's fill are zero. 0 = the CPU key and fill alone.
     */
    gridLights: i32,
};
@group(1) @binding(1) var<uniform> u_material: SpriteLitMaterial;

// This fragment's sprite, set once at the top of fs_main from its instance.
//   spriteRight, spriteUp, spriteBack: its frame, unit vectors: its right, its up, and BACK, away from the
//     camera (the bake's). A quad seen from behind (a free sprite) shows its texture mirrored, so its frame
//     is mirrored with it.
//   spriteLightRadius: metres, the nearest a local light is taken to be, in the six-way and flat modes. Such
//     a sprite stands for a VOLUME of smoke as thick as the quad is wide (half its smaller world extent), so a
//     light inside it lights that volume, not the one quad pixel it sits on: without the floor a fire's light
//     at the smoke's root was a 1/d^2 spike over its 8 cm source, a white orb at night. The surface mode (a
//     liquid's skin) keeps the true distance.
var<private> spriteRight: vec3<f32>;
var<private> spriteUp: vec3<f32>;
var<private> spriteBack: vec3<f32>;
var<private> spriteLightRadius: f32;

/** Six-way: how much light from `l` (a unit direction toward it, in the sprite's frame) the frame scatters to the eye. */
fn sixWayLight(l: vec3<f32>, pos: vec4<f32>, neg: vec4<f32>) -> f32 {
    let w = l * l;
    let x = select(neg.r, pos.r, l.x > 0.0);
    let y = select(neg.g, pos.g, l.y > 0.0);
    let z = select(neg.b, pos.b, l.z > 0.0);
    return w.x * x + w.y * y + w.z * z;
}

/** `d`, a world direction, in the sprite's frame (right, up, back). */
fn spriteFrame(d: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(dot(d, spriteRight), dot(d, spriteUp), dot(d, spriteBack));
}

/** GGX highlight of one light (Cook-Torrance, Schlick Fresnel, Smith-Schlick visibility), times N.L. */
fn spriteSpecular(N: vec3<f32>, V: vec3<f32>, L: vec3<f32>, roughness: f32, f0: vec3<f32>) -> vec3<f32> {
    let H = normalize(L + V);
    let nl = max(dot(N, L), 0.0);
    let nv = max(dot(N, V), 1e-4);
    let nh = max(dot(N, H), 0.0);
    let a = roughness * roughness;
    let a2 = a * a;
    let dd = nh * nh * (a2 - 1.0) + 1.0;
    let D = a2 / (SPRITE_PI * dd * dd);
    let k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
    let G = (nl / (nl * (1.0 - k) + k)) * (nv / (nv * (1.0 - k) + k));
    let F = f0 + (vec3<f32>(1.0) - f0) * pow(1.0 - max(dot(H, V), 0.0), 5.0);
    return D * G * F / max(4.0 * nl * nv, 1e-4) * nl;
}

/** What the clustered local lights add, by mode, for one pixel. */
struct LocalLight {
    /** Six-way: the sum of each light's irradiance times the six-way response to its direction. */
    sixWay: vec3<f32>,
    /** Surface and flat: the sum of each light's irradiance times its N.L (half-Lambert for flat). */
    diffuse: vec3<f32>,
    /** Surface: the GGX highlights. */
    specular: vec3<f32>,
};

/**
 * Every point and spot light that reaches `p`, through the frame's cluster grid (the same lights, falloff
 * and cone the surfaces use). The light records are pre-exposed, so the sums come back divided by the
 * pre-exposure: absolute, like the rest of this program's light, which multiplies it in once at the end.
 */
fn localLights(p: vec3<f32>, viewDepth: f32, fragXY: vec2<f32>, mode: i32, N: vec3<f32>, V: vec3<f32>,
               roughness: f32, f0: vec3<f32>, pos: vec4<f32>, neg: vec4<f32>, preExposure: f32) -> LocalLight {
    var out: LocalLight;
    out.sixWay = vec3<f32>(0.0);
    out.diffuse = vec3<f32>(0.0);
    out.specular = vec3<f32>(0.0);
    let cluster = cleoClusterOf(fragXY, viewDepth);
    let first = cleoClusterOffset(cluster);
    let count = cleoClusterCount(cluster);
    let k = 1.0 / max(preExposure, 1e-8);
    for (var i = 0; i < count; i++) {
        let cl = cleoLight(cleoClusterLight(first + i));
        if (cleoLightReaches(cl.light, p)) {
            let toLight = cl.light.position - p;
            // A medium's light floor (`lightRadius`), a surface's own source radius: see the material block.
            let floorRadius = select(cl.light.sourceRadius, max(cl.light.sourceRadius, spriteLightRadius), mode != 2);
            let d2 = max(dot(toLight, toLight), floorRadius * floorRadius);
            let L = toLight * inverseSqrt(max(dot(toLight, toLight), 1e-8));
            let cone = spotAttenuation(dot(-L, cl.light.direction), cl.light.coneScale, cl.light.coneOffset);
            let E = cl.light.color * (cl.light.intensity * distanceAttenuation(d2, cl.light.invRangeSquared) * cone * k);
            if (mode == 1) {
                out.sixWay += E * sixWayLight(spriteFrame(L), pos, neg);
            } else if (mode == 2) {
                out.diffuse += E * max(dot(N, L), 0.0);
                out.specular += E * spriteSpecular(N, V, L, roughness, f0);
            } else {
                out.diffuse += E * (dot(N, L) * 0.5 + 0.5);
            }
        }
    }
    return out;
}

/** A window depth's distance along the camera axis (as chunks/basicForward.wgsl `basicViewDepth`). */
fn spriteViewDepth(d: f32) -> f32 {
    let near = u_material.depthParams.x;
    let far = u_material.depthParams.y;
    if (u_material.depthParams.z > 0.5) { return near + d * (far - near); }
    let z = d * 2.0 - 1.0;
    return 2.0 * near * far / (far + near - z * (far - near));
}

@fragment
fn fs_main(in: SpriteLitVaryings) -> @location(0) vec4<f32> {
    // Every sample first, in uniform control flow, before anything can discard.
    let tex = textureSample(u_material_texture_texture, u_material_texture_sampler, in.uv);
    let mapA = textureSample(u_material_mapA_texture, u_material_mapA_sampler, in.uv);
    let mapB = textureSample(u_material_mapB_texture, u_material_mapB_sampler, in.uv);
    // A despawn dissolve: see Node.remove and chunks/dither.wgsl.
    if (!dissolveKeeps(in.dissolve, in.position.xy)) { discard; }

    let m = u_material;
    cleoFragCoord = in.position.xy;
    // The sprite's frame (as render/sprites2d.ts built it per draw before batching): back = -(right x up),
    // and both back and right turned over when the camera is behind the quad.
    var right = in.right;
    var back = normalize(-cross(right, in.up));
    if (dot(in.centre - m.viewPos, back) < 0.0) { back = -back; right = -right; }
    spriteRight = right;
    spriteUp = in.up;
    spriteBack = back;
    spriteLightRadius = in.params.x;
    let ambient = in.extra.yzw;
    // The key light's shadow ON THE QUAD (a single tap: smoke is soft, and its own self-shadow is baked),
    // at the shadow strength the scene sets, and the clouds'.
    let tap = shadowVisibility(in.worldPos, in.viewDepth);
    let vis = (1.0 - (1.0 - tap) * u_shadow.u_shadowStrength) * cleoCloudShadow(in.worldPos);
    let tint = toLinear(in.look.rgb);
    var rgb = vec3<f32>(0.0);
    var alpha = in.look.a;

    if (m.mode == 1) {
        // Six-way. The maps are lighting data (linear), not colour.
        let sun = sixWayLight(spriteFrame(m.sunDir), mapA, mapB);
        let key = sixWayLight(spriteFrame(m.keyDir), mapA, mapB);
        // Light from everywhere at once: the six responses' mean.
        let fill = (mapA.r + mapA.g + mapA.b + mapB.r + mapB.g + mapB.b) / 6.0;
        rgb = tint * (ambient * fill + (m.sunColor * vis * sun + m.keyColor * key) / SPRITE_PI);
        if (m.gridLights != 0) {
            let local = localLights(in.worldPos, in.viewDepth, in.position.xy, 1, vec3<f32>(0.0, 0.0, 1.0),
                                    vec3<f32>(0.0, 0.0, 1.0), 1.0, vec3<f32>(0.04), mapA, mapB, m.preExposure);
            rgb += tint * local.sixWay / SPRITE_PI;
        }
        // A fire inside the smoke: the colour atlas where the negative map says it emits.
        if (m.hasTexture != 0) { rgb += toLinear(tex.rgb) * mapB.a * in.extra.x; }
        alpha *= mapA.a;
    } else if (m.mode == 2) {
        // Surface: base colour, normal, ORM.
        var albedo = tint;
        if (m.hasTexture != 0) { albedo *= toLinear(tex.rgb); alpha *= tex.a; }
        let nt = mapA.xyz * 2.0 - 1.0;
        let toward = -spriteBack;
        let N = normalize(spriteRight * nt.x + spriteUp * nt.y + toward * nt.z);
        let V = normalize(m.viewPos - in.worldPos);
        var occlusion = 1.0;
        var roughness = 0.5;
        var metallic = 0.0;
        if (m.hasOrm != 0) { occlusion = mapB.r; roughness = mapB.g; metallic = mapB.b; }
        roughness = clamp(roughness, 0.04, 1.0);
        let f0 = mix(vec3<f32>(0.04), albedo, metallic);
        let diffuse = albedo * (1.0 - metallic);
        let sunL = max(dot(N, m.sunDir), 0.0);
        let keyL = max(dot(N, m.keyDir), 0.0);
        rgb = diffuse * (ambient * occlusion + (m.sunColor * vis * sunL + m.keyColor * keyL) / SPRITE_PI);
        rgb += m.sunColor * vis * spriteSpecular(N, V, m.sunDir, roughness, f0)
             + m.keyColor * spriteSpecular(N, V, m.keyDir, roughness, f0);
        if (m.gridLights != 0) {
            let local = localLights(in.worldPos, in.viewDepth, in.position.xy, 2, N, V, roughness, f0,
                                    mapA, mapB, m.preExposure);
            rgb += diffuse * local.diffuse / SPRITE_PI + local.specular;
        }
        // A little of the fill in the highlight, so a glossy liquid is not flat away from the lights.
        rgb += ambient * f0 * occlusion * (1.0 - roughness) * 0.5;
    } else {
        // Flat: half-Lambert, a card facing the camera.
        var albedo = tint;
        if (m.hasTexture != 0) { albedo *= toLinear(tex.rgb); alpha *= tex.a; }
        let n = -spriteBack;
        let sunWrap = dot(n, m.sunDir) * 0.5 + 0.5;
        let keyWrap = dot(n, m.keyDir) * 0.5 + 0.5;
        rgb = albedo * (ambient + (m.sunColor * vis * sunWrap + m.keyColor * keyWrap) / SPRITE_PI);
        if (m.gridLights != 0) {
            let local = localLights(in.worldPos, in.viewDepth, in.position.xy, 0, n, n, 1.0, vec3<f32>(0.04),
                                    mapA, mapB, m.preExposure);
            rgb += albedo * local.diffuse / SPRITE_PI;
        }
    }

    // Soft fade: the view depths of the scene behind and of this fragment, from the same window depth.
    let softness = in.params.y;
    if (softness > 0.0 && m.depthParams.w > 0.5) {
        let uv = in.position.xy / vec2<f32>(textureDimensions(u_sceneDepth_texture, 0));
        let scene = spriteViewDepth(textureSampleLevel(u_sceneDepth_texture, u_sceneDepth_sampler, uv, 0));
        alpha *= clamp((scene - spriteViewDepth(in.position.z)) / softness, 0.0, 1.0);
    }
    let preExposure = select(1.0, m.preExposure, m.preExposure > 0.0);
    return vec4<f32>(min(rgb * preExposure, vec3<f32>(32768.0)), alpha);
}

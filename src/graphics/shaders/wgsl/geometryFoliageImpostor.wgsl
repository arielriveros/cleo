// Deferred geometry pass for OCTAHEDRAL foliage impostors (terrain/octahedralImpostor.ts).
//
// Each instance is one camera-facing quad. Its view direction, taken into the instance's own space, picks
// the three nearest of the N x N baked views (hemi-octahedral grid) and their barycentric weights; each
// quad corner is reprojected into each of the three frames, so the fragment stage only samples and blends.
// The bake is UNLIT albedo plus a model-space normal, so the G-buffer gets a real surface and the impostor
// is lit, shadowed and fogged like the mesh it stands in for.
//
// The conventions — frame layout, direction, basis, uv — are pinned by tests/octahedralImpostor.test.ts
// against the TypeScript twins in octahedralImpostor.ts, which the baker uses. A disagreement draws the
// wrong side of the tree rather than failing, so change both or neither.

// For lodFadeKeeps and octEncode. Its VertexOutput goes unused: this stage carries its own varyings.
#include "./chunks/modelVarying.wgsl"
#include "./chunks/tonemap.wgsl"
#include "./chunks/alphaCutout.wgsl"

@group(0) @binding(0) var u_albedo_texture: texture_2d<f32>;
@group(0) @binding(1) var u_albedo_sampler: sampler;
@group(0) @binding(2) var u_normal_texture: texture_2d<f32>;
@group(0) @binding(3) var u_normal_sampler: sampler;

struct ImpostorTransform {
    u_view: mat4x4<f32>,
    u_projection: mat4x4<f32>,
    // Foliage LOD crossfade, exactly as chunks/instancedVertex.wgsl reads it (xyz of u_lodCamera is the eye).
    u_lodBand: vec4<f32>,
    u_lodCamera: vec4<f32>,
    u_lodFrame: vec4<f32>,
    // x = frames per side, y = capture radius (model units), z = 1 when the atlas texture keeps the image's
    // rows top-down, 0 when it was flipped on upload (the engine's default, `TextureConfig.flipY` false).
    u_impostor: vec4<f32>,
    // xyz = capture centre (model space).
    u_impostorCenter: vec4<f32>,
};
@group(1) @binding(0) var<uniform> u_transform: ImpostorTransform;

struct ImpostorVarying {
    @builtin(position) position: vec4<f32>,
    // Each blended frame's uv inside its own frame (0..1, v up), for frames 0 and 1 / frame 2.
    @location(0) frameUv01: vec4<f32>,
    @location(1) frameUv2: vec2<f32>,
    // Their grid cells (column, row) and weights, one set per instance; weights.w = 1 / frames per side
    // (the fragment stage reads no uniform: a block read by both stages fails to link on GLSL ES 3.0).
    @location(2) @interpolate(flat) cells01: vec4<f32>,
    @location(3) @interpolate(flat) cell2: vec2<f32>,
    @location(4) @interpolate(flat) weights: vec4<f32>,
    @location(5) lodFade: vec3<f32>,
    // The instance's rotation, to take the baked model-space normals to world space.
    @location(6) @interpolate(flat) axisX: vec3<f32>,
    @location(7) @interpolate(flat) axisY: vec3<f32>,
    @location(8) @interpolate(flat) axisZ: vec3<f32>,
    // u_impostor.z, for `atlasUv`: a varying, not a uniform read, for the reason `weights.w` is one.
    @location(9) @interpolate(flat) atlasTopDown: f32,
};

/** Unit direction (y >= 0) -> hemi-octahedral uv in [0, 1]². Below the horizon folds up. */
fn hemiOctEncode(d: vec3<f32>) -> vec2<f32> {
    let s = max(abs(d.x) + abs(d.y) + abs(d.z), 1e-6);
    let px = d.x / s;
    let pz = d.z / s;
    return vec2<f32>((px + pz) * 0.5 + 0.5, (px - pz) * 0.5 + 0.5);
}

/** Hemi-octahedral uv -> unit direction with y >= 0. */
fn hemiOctDecode(uv: vec2<f32>) -> vec3<f32> {
    let a = uv.x * 2.0 - 1.0;
    let b = uv.y * 2.0 - 1.0;
    let x = (a + b) * 0.5;
    let z = (a - b) * 0.5;
    return normalize(vec3<f32>(x, max(0.0, 1.0 - abs(x) - abs(z)), z));
}

/** Image right for a view along -d; image up is cross(d, right). World +Z stands in for up at the zenith. */
fn frameRight(d: vec3<f32>) -> vec3<f32> {
    let up = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(0.0, 0.0, 1.0), abs(d.y) > 0.999);
    return normalize(cross(up, d));
}

/**
 * Where the quad point `p` (model space) lands in the frame of `cell`: the view ray through it (along
 * `-view`) meets the frame's plane through the centre, and that point projects into the frame's image.
 * Affine in `p`, so it is exact to compute per corner and interpolate.
 */
fn frameUvOf(cell: vec2<f32>, p: vec3<f32>, view: vec3<f32>) -> vec2<f32> {
    let n = u_transform.u_impostor.x - 1.0;
    let d = hemiOctDecode(cell / n);
    let c = u_transform.u_impostorCenter.xyz;
    let r2 = 2.0 * u_transform.u_impostor.y;
    let along = max(dot(view, d), 0.05);
    let q = p - view * (dot(p - c, d) / along) - c;
    let t = frameRight(d);
    let b = cross(d, t);
    return vec2<f32>(dot(q, t) / r2 + 0.5, dot(q, b) / r2 + 0.5);
}

@vertex
fn vs_main(
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
    @location(3) tangent: vec3<f32>,
    @location(4) bitangent: vec3<f32>,
    @location(5) instanceModel0: vec4<f32>,
    @location(6) instanceModel1: vec4<f32>,
    @location(7) instanceModel2: vec4<f32>,
    @location(8) instanceModel3: vec4<f32>,
) -> ImpostorVarying {
    let model = mat4x4<f32>(instanceModel0, instanceModel1, instanceModel2, instanceModel3);
    let m3 = mat3x3<f32>(model[0].xyz, model[1].xyz, model[2].xyz);
    // Foliage instances scale uniformly (position, yaw or a ground tilt, and one scale).
    let s = max(length(model[1].xyz), 1e-6);
    let centre = model * vec4<f32>(u_transform.u_impostorCenter.xyz, 1.0);
    let radius = u_transform.u_impostor.y * s;
    let eye = u_transform.u_lodCamera.xyz;
    let toEye = normalize(eye - centre.xyz);

    // The quad: the corner from the card's uv (v = 0 at the top), spanning the captured sphere, upright on
    // screen. A hair larger than the sphere, which a perspective view sees slightly wider than its radius.
    let corner = vec2<f32>(texCoord.x * 2.0 - 1.0, 1.0 - texCoord.y * 2.0);
    let right = frameRight(toEye);
    let up = cross(toEye, right);
    let world = centre.xyz + (right * corner.x + up * corner.y) * radius * 1.04;

    // Into the instance's own space (model units), where the frames were captured.
    let toLocal = transpose(m3) * (1.0 / (s * s));
    let view = normalize(toLocal * toEye);
    let local = u_transform.u_impostorCenter.xyz + toLocal * (world - centre.xyz);

    // The three frames around the view direction: the corners of its grid triangle, barycentric weights.
    let n = u_transform.u_impostor.x - 1.0;
    let g = clamp(hemiOctEncode(view) * n, vec2<f32>(0.0), vec2<f32>(n - 1e-4));
    let c = floor(g);
    let f = g - c;
    var c0 = c;
    var c1 = c + vec2<f32>(1.0, 0.0);
    var c2 = c + vec2<f32>(0.0, 1.0);
    var w = vec3<f32>(1.0 - f.x - f.y, f.x, f.y);
    if (f.x + f.y >= 1.0) {
        c0 = c + vec2<f32>(1.0, 1.0);
        c1 = c + vec2<f32>(0.0, 1.0);
        c2 = c + vec2<f32>(1.0, 0.0);
        w = vec3<f32>(f.x + f.y - 1.0, 1.0 - f.x, 1.0 - f.y);
    }

    var out: ImpostorVarying;
    out.frameUv01 = vec4<f32>(frameUvOf(c0, local, view), frameUvOf(c1, local, view));
    out.frameUv2 = frameUvOf(c2, local, view);
    out.cells01 = vec4<f32>(c0, c1);
    out.cell2 = c2;
    out.weights = vec4<f32>(w, 1.0 / u_transform.u_impostor.x);
    out.atlasTopDown = u_transform.u_impostor.z;
    out.axisX = model[0].xyz / s;
    out.axisY = model[1].xyz / s;
    out.axisZ = model[2].xyz / s;

    // The LOD crossfade, as chunks/instancedVertex.wgsl: each INSTANCE fades by its own distance.
    out.lodFade = vec3<f32>(1.0, 1.0, 0.0);
    var hidden = false;
    if (u_transform.u_lodCamera.w > 0.5) {
        let dist = distance(model[3].xyz, eye);
        let band = u_transform.u_lodBand;
        let fadeIn = select(1.0, smoothstep(band.x, band.y, dist), band.y > band.x);
        let fadeOut = select(1.0, 1.0 - smoothstep(band.z, band.w, dist), band.w > band.z);
        out.lodFade = vec3<f32>(fadeIn, fadeOut, u_transform.u_lodFrame.x);
        hidden = min(fadeIn, fadeOut) <= 0.0;
    }

    // Rasterized half a radius toward the eye, ALONG the eye ray so nothing moves on screen: a quad through
    // the centre would sink its lower half into a slope it stands on, cutting the trunk off at the ground.
    let pulled = world + normalize(eye - world) * radius * 0.5;
    out.position = u_transform.u_projection * u_transform.u_view * vec4<f32>(pulled, 1.0);
    if (hidden) { out.position = vec4<f32>(0.0, 0.0, 2.0, 1.0); }
    return out;
}

struct GBuffer {
    @location(0) albedoMetallic: vec4<f32>,
    @location(1) normalRoughness: vec4<f32>,
    @location(2) emissiveAO: vec4<f32>,
};

/**
 * One frame's atlas uv: its tile, its own uv flipped to the image's top-down rows (row 0 is the top of the
 * image the baker writes). A texture flipped on upload — every texture asset, unless its settings say
 * otherwise — holds that image bottom-up, so its v runs the other way. Missing that turned every impostor
 * upside down, and swapped each view for the one mirrored across the grid.
 */
fn atlasUv(cell: vec2<f32>, uv: vec2<f32>, invFrames: f32, topDown: f32) -> vec2<f32> {
    let inside = clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0));
    let t = (cell + vec2<f32>(inside.x, 1.0 - inside.y)) * invFrames;
    return select(vec2<f32>(t.x, 1.0 - t.y), t, topDown > 0.5);
}

/** 1 inside the frame, 0 outside: a reprojected corner can land past the frame's edge. */
fn insideFrame(uv: vec2<f32>) -> f32 {
    return select(0.0, 1.0, all(uv >= vec2<f32>(0.0)) && all(uv <= vec2<f32>(1.0)));
}

@fragment
fn fs_main(in: ImpostorVarying) -> GBuffer {
    let uv0 = atlasUv(in.cells01.xy, in.frameUv01.xy, in.weights.w, in.atlasTopDown);
    let uv1 = atlasUv(in.cells01.zw, in.frameUv01.zw, in.weights.w, in.atlasTopDown);
    let uv2 = atlasUv(in.cell2, in.frameUv2, in.weights.w, in.atlasTopDown);
    // Every sample unconditionally: they sit in uniform control flow, where derivatives are defined.
    let a0 = textureSample(u_albedo_texture, u_albedo_sampler, uv0);
    let a1 = textureSample(u_albedo_texture, u_albedo_sampler, uv1);
    let a2 = textureSample(u_albedo_texture, u_albedo_sampler, uv2);
    let n0 = textureSample(u_normal_texture, u_normal_sampler, uv0);
    let n1 = textureSample(u_normal_texture, u_normal_sampler, uv1);
    let n2 = textureSample(u_normal_texture, u_normal_sampler, uv2);

    // Coverage-weighted: each frame contributes by its weight AND by how much of it is there, so a frame
    // whose silhouette ends here does not drag the blend toward its empty background.
    let k = in.weights.xyz * vec3<f32>(a0.a * insideFrame(in.frameUv01.xy), a1.a * insideFrame(in.frameUv01.zw),
                                   a2.a * insideFrame(in.frameUv2));
    let coverage = k.x + k.y + k.z;
    // Mip-aware, like every other foliage cutout, so a distant canopy keeps its density instead of thinning.
    let a = cutoutAlpha(coverage, dpdx(uv0), dpdy(uv0), textureDimensions(u_albedo_texture, 0));
    if (a < 0.5) { discard; }
    if (!lodFadeKeeps(in.lodFade, in.position.xy)) { discard; }

    let wk = k / max(coverage, 1e-4);
    let albedo = a0.rgb * wk.x + a1.rgb * wk.y + a2.rgb * wk.z;
    let nLocal = (n0.xyz * 2.0 - 1.0) * wk.x + (n1.xyz * 2.0 - 1.0) * wk.y + (n2.xyz * 2.0 - 1.0) * wk.z;
    let ao = n0.a * wk.x + n1.a * wk.y + n2.a * wk.z;
    let nWorld = normalize(in.axisX * nLocal.x + in.axisY * nLocal.y + in.axisZ * nLocal.z);

    var out: GBuffer;
    out.albedoMetallic = vec4<f32>(toLinear(albedo), 0.0);   // sRGB -> linear
    let octN = octEncode(nWorld);
    // Matte foliage: dielectric reflectance, high roughness — what the leaf materials it replaces use.
    out.normalRoughness = vec4<f32>(octN.x, octN.y, 0.5, 0.8);
    out.emissiveAO = vec4<f32>(0.0, 0.0, 0.0, ao);
    return out;
}

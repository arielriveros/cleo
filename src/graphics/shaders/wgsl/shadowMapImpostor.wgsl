// Depth-only pass that casts a mesh foliage layer's shadow through its OCTAHEDRAL impostor
// (terrain/octahedralImpostor.ts) instead of its cheapest mesh level — the outer cascades, whose texels
// are as coarse as the impostor's own (see `Renderer._impostorCasts`).
//
// Each instance is one quad facing the LIGHT. The light direction, taken into the instance's own space,
// picks the nearest of the N x N baked views, and the quad's corners are reprojected into that frame as in
// geometryFoliageImpostor.wgsl; the fragment stage alpha-tests the frame's coverage. A view from the sun is
// the tree as the sun sees it, which is exactly the shape its shadow has.
//
// The views carry no depth, so every texel takes the depth of a ROUND canopy: halfway between the capture
// sphere's centre and its sun-facing surface. Depth flat through the centre would put a hard terminator
// straight across every tree that receives its own shadow; the bulge rounds it the way the mesh's would.
//
// The frame conventions are geometryFoliageImpostor.wgsl's, pinned by tests/octahedralImpostor.test.ts.

#include "./chunks/alphaCutout.wgsl"

@group(0) @binding(0) var u_albedo_texture: texture_2d<f32>;
@group(0) @binding(1) var u_albedo_sampler: sampler;

struct ImpostorDepthUniforms {
    u_lightSpace: mat4x4<f32>,
    // xyz = the unit direction the light TRAVELS; w = window depth per world unit along it (the renderer
    // knows which clip-depth convention the backend uses; this shader does not).
    u_lightDir: vec4<f32>,
    // x = frames per side, y = capture radius (model units), z = 1 when the atlas keeps the image's rows
    // top-down, 0 when it was flipped on upload — see `atlasUv` in geometryFoliageImpostor.wgsl.
    u_impostor: vec4<f32>,
    // xyz = capture centre (model space).
    u_impostorCenter: vec4<f32>,
};
@group(1) @binding(0) var<uniform> u_depth: ImpostorDepthUniforms;

struct ImpostorDepthVarying {
    @builtin(position) position: vec4<f32>,
    // The frame's uv (0..1, v up) and the quad corner in [-1, 1]² it came from.
    @location(0) frameUv: vec2<f32>,
    @location(1) disc: vec2<f32>,
    // x, y = the frame's grid cell; z = 1 / frames per side; w = the canopy's depth bulge in window
    // units. Varyings rather than uniforms: a block read by both stages fails to link on GLSL ES 3.0.
    @location(2) @interpolate(flat) cell: vec4<f32>,
    // u_impostor.z.
    @location(3) @interpolate(flat) atlasTopDown: f32,
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

/** Where the quad point `p` (model space), seen along `-view`, lands in the frame of `cell`. */
fn frameUvOf(cell: vec2<f32>, p: vec3<f32>, view: vec3<f32>) -> vec2<f32> {
    let n = u_depth.u_impostor.x - 1.0;
    let d = hemiOctDecode(cell / n);
    let c = u_depth.u_impostorCenter.xyz;
    let r2 = 2.0 * u_depth.u_impostor.y;
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
) -> ImpostorDepthVarying {
    let model = mat4x4<f32>(instanceModel0, instanceModel1, instanceModel2, instanceModel3);
    let m3 = mat3x3<f32>(model[0].xyz, model[1].xyz, model[2].xyz);
    // Foliage instances scale uniformly (position, yaw or a ground tilt, and one scale).
    let s = max(length(model[1].xyz), 1e-6);
    let centre = model * vec4<f32>(u_depth.u_impostorCenter.xyz, 1.0);
    let radius = u_depth.u_impostor.y * s;
    let toLight = -normalize(u_depth.u_lightDir.xyz);

    // The quad: the corner from the card's uv (v = 0 at the top), spanning the captured sphere, square to
    // the light. A hair larger than the sphere, as the colour pass draws it.
    let corner = vec2<f32>(texCoord.x * 2.0 - 1.0, 1.0 - texCoord.y * 2.0);
    let right = frameRight(toLight);
    let up = cross(toLight, right);
    let world = centre.xyz + (right * corner.x + up * corner.y) * radius * 1.04;

    // Into the instance's own space (model units), where the frames were captured, and the one frame
    // nearest the light — the sun moves slowly, so a blend across frames would buy nothing a shadow shows.
    let toLocal = transpose(m3) * (1.0 / (s * s));
    let view = normalize(toLocal * toLight);
    let local = u_depth.u_impostorCenter.xyz + toLocal * (world - centre.xyz);
    let n = u_depth.u_impostor.x - 1.0;
    let cell = clamp(round(hemiOctEncode(view) * n), vec2<f32>(0.0), vec2<f32>(n));

    var out: ImpostorDepthVarying;
    out.frameUv = frameUvOf(cell, local, view);
    out.disc = corner * 1.04;
    out.cell = vec4<f32>(cell, 1.0 / u_depth.u_impostor.x, 0.5 * radius * u_depth.u_lightDir.w);
    out.atlasTopDown = u_depth.u_impostor.z;
    out.position = u_depth.u_lightSpace * vec4<f32>(world, 1.0);
    return out;
}

@fragment
fn fs_main(in: ImpostorDepthVarying) -> @builtin(frag_depth) f32 {
    // The frame's tile in the atlas, its uv flipped to the image's top-down rows — and back again for a
    // texture flipped on upload, which holds that image bottom-up.
    let inside = clamp(in.frameUv, vec2<f32>(0.0), vec2<f32>(1.0));
    let t = (in.cell.xy + vec2<f32>(inside.x, 1.0 - inside.y)) * in.cell.z;
    let uv = select(vec2<f32>(t.x, 1.0 - t.y), t, in.atlasTopDown > 0.5);
    // Sampled unconditionally, in uniform control flow, where its derivatives are defined.
    let texel = textureSample(u_albedo_texture, u_albedo_sampler, uv);
    let inFrame = all(in.frameUv >= vec2<f32>(0.0)) && all(in.frameUv <= vec2<f32>(1.0));
    let coverage = cutoutAlpha(select(0.0, texel.a, inFrame), dpdx(uv), dpdy(uv), textureDimensions(u_albedo_texture, 0));
    if (coverage < 0.5) { discard; }
    // Toward the light by the canopy's bulge at this point of the disc.
    let bulge = sqrt(max(0.0, 1.0 - dot(in.disc, in.disc)));
    return clamp(in.position.z - in.cell.w * bulge, 0.0, 1.0);
}

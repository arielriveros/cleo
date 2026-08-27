// Alpha-cutout depth pass for a masked mesh using the lit (PBR / Blinn-Phong) vertex layout.
//
// One of FOUR cutout depth variants, and the split is forced rather than tidy. `texCoord` sits at
// location 2 for this family and at location 1 for the Basic one, and the skinned
// variants pack bone data at different locations again — so a single shared program cannot read uv for
// all of them. `_renderShadowCasters` picks the variant that matches the caster's material family.
//
// Every attribute the matching colour program declares is declared here too, even where unused. That
// is load-bearing: `Mesh.initializeVAO` derives the interleaved stride from ONLY the attributes a
// program declares, so a depth program with a narrower set would re-stride the mesh and corrupt the
// colour pass. See the same note in chunks/instancedDepthVertex.wgsl.
//
// shadowMap.wgsl is deliberately NOT extended to cover this: `_ensureOverlayMeshes` builds
// position-only VAOs from its reflected attributes, so adding a uv input there would change what those
// meshes interleave.

// `u_texture`, not `u_material_maskMap`: this pass binds group 0 EXPLICITLY with the one texture the
// caster's cutout uses, the way the instanced foliage cutout already does. A `u_material_*` name would
// route through _materialBindGroup, which resolves each sampler from the material's own slot map — and
// the texture wanted here is sometimes the mask and sometimes the base colour.
@group(0) @binding(0) var u_texture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_texture_sampler: sampler;

struct CutoutDepthUniforms {
    u_cutoff: f32,
    /**
     * Which channel carries coverage: red for a dedicated mask, alpha for a base-colour texture.
     *
     * One uniform instead of a second pair of programs. The surface shaders pick between exactly these
     * two sources in the same order (mask first, base-colour alpha as the fallback), and a shadow that
     * disagreed with the surface about which texels exist is worse than no cutout at all.
     */
    u_useRed: i32,
};
@group(1) @binding(1) var<uniform> u_cutout: CutoutDepthUniforms;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

struct ShadowMapUniforms {
    u_model: mat4x4<f32>,
    u_lightSpace: mat4x4<f32>,
};
@group(1) @binding(0) var<uniform> u_shadow: ShadowMapUniforms;

@vertex
fn vs_main(
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
    @location(3) tangent: vec3<f32>,
    @location(4) bitangent: vec3<f32>,
) -> VertexOutput {
    var out: VertexOutput;
    out.uv = texCoord;
    out.position = u_shadow.u_lightSpace * u_shadow.u_model * vec4<f32>(position, 1.0);
    return out;
}

@fragment
fn fs_main(in: VertexOutput) {
    let texel = textureSample(u_texture_texture, u_texture_sampler, in.uv);
    let coverage = select(texel.a, texel.r, u_cutout.u_useRed != 0);
    if (coverage < u_cutout.u_cutoff) { discard; }
}

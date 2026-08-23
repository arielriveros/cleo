// Tilemap chunk geometry: a flat XY quad grid sampled from one tileset atlas.

#include "./chunks/tonemap.wgsl"

// The attribute locations are explicit because a chunk's VAO is set up by TileMesh directly rather than
// through Mesh's canonical-attribute reflection, so these numbers are the contract between the two —
// see LOC_POSITION/LOC_UV/LOC_COLOR in src/graphics/tilemap/tileMesh.ts.
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) tint: vec4<f32>,
};

struct TilemapTransform {
    u_model: mat4x4<f32>,
    u_view: mat4x4<f32>,
    u_projection: mat4x4<f32>,
};
@group(1) @binding(0) var<uniform> u_transform: TilemapTransform;

@group(0) @binding(0) var u_tileset_texture: texture_2d<f32>;
@group(0) @binding(1) var u_tileset_sampler: sampler;

@vertex
fn vs_main(
    @location(0) position: vec2<f32>,
    @location(1) texCoord: vec2<f32>,
    @location(2) color: vec4<f32>,
) -> VertexOutput {
    var out: VertexOutput;
    out.uv = texCoord;
    out.tint = color;
    // Tiles are flat on the XY plane; the layer's z offset and parallax shift both ride in u_model.
    out.position = u_transform.u_projection * u_transform.u_view * u_transform.u_model
                 * vec4<f32>(position, 0.0, 1.0);
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let texel = textureSample(u_tileset_texture, u_tileset_sampler, in.uv);
    // Tile art is overwhelmingly cut-out rather than blended, and the tilemap pass draws with depth
    // writes off; discarding fully transparent texels keeps a transparent tile from tinting whatever was
    // already in the buffer with its (usually black) unused pixels.
    if (texel.a < 0.004) { discard; }

    // Both the texture and the authored tint are sRGB; this shader writes into the linear-HDR scene
    // buffer and is tonemapped once at the final present, like every other surface.
    return vec4<f32>(toLinear(texel.rgb) * toLinear(in.tint.rgb), texel.a * in.tint.a);
}

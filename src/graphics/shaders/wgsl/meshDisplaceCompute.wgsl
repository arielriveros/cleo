// Compute-shader tessellation and displacement: a mesh's height map turned into real geometry.
//
// WHY A COMPUTE PASS. WebGPU has no tessellation stage and is not getting one (wgpu #222, gpuweb #445 —
// the software route, mesh shaders, is absent from Metal and from D3D's WebGPU surface). So the
// tessellator is written here, and its output buffers are fed straight into the render pipeline. There
// is no readback: the displaced mesh never leaves the GPU, which is what makes this affordable and what
// makes it re-runnable on a slider drag rather than a minutes-long CPU bake.
//
// WHY AT ALL, when chunks/parallax.wgsl exists. POM cannot move a silhouette — it offsets texture
// coordinates and never touches a vertex — and it flattens at steep angles, which is everywhere on the
// photogrammetry scan this was written for (25.6 degree median dihedral, 80.4 at p90). Its height map
// IS the high-poly geometry that was decimated away, and re-deriving that per fragment from a flat
// polygon is the hardest possible way to get it back. The standard split for scanned assets is
// low-frequency detail into the MESH and high-frequency into the normal map; this is the first half.
//
// WEBGPU ONLY, deliberately. WebGL2 has no compute and keeps POM. The two backends will not match on a
// displaced model, which makes a backend-diff comparison meaningless for one — that is a capability
// split, not a bug.
//
// NO GLSL HALF, by construction: tools/wgslTranslate.mjs sends only raster stages through naga, because
// GLSL ES 300 has no compute stage to translate to. See cloudNoiseBakeCompute.wgsl, which is the other
// module in this position and the template this dispatch follows.

struct MeshDisplaceUniforms {
    /** Input triangles. The dispatch covers `triangleCount * vertsPerTri` invocations. */
    u_triangleCount: u32,
    /** Segments per triangle edge — `2^level`, so 8 at the default level 3. */
    u_segments: u32,
    /** Vertices one input triangle expands to: the triangular number `(n+1)(n+2)/2`. */
    u_vertsPerTri: u32,
    /** Floats per vertex in BOTH the input and output buffers. The engine's model vertex is 14. */
    u_stride: u32,
    /** Relief depth in WORLD units. Already converted from the material's uv depth by the caller. */
    u_depth: f32,
    /**
     * Mip level of the 1x1 top of the pyramid, which IS the mean of the map.
     *
     * The displacement is CENTRED on that mean, not applied raw. Displacing by `h` alone moves every
     * vertex outward by one mean amplitude and inflates the whole object — which is what "I have to
     * invert the height map" actually is: the polarity was never wrong, the REFERENCE PLANE moved.
     * Passed as a LEVEL rather than a value because `generateMipmaps` is a box filter, so the top mip
     * already holds the arithmetic mean: one extra sample here, instead of a CPU decode that could go
     * stale against the texture it describes.
     */
    u_meanLod: f32,
    /**
     * Mip to sample, matching the output vertex spacing.
     *
     * BAND-LIMITED on purpose. Undersampled detail does not disappear, it folds down into low-frequency
     * beat patterns — the deleted terrain bake's header is a long warning about exactly this. At level 3
     * on a 4096 map over this scan an output edge is ~10 texels, so this is around mip 3.
     */
    u_lod: f32,
    /** Non-zero when the map is a DEPTH map (white = deep), which most downloaded PBR packs ship. */
    u_invert: i32,
    /** Texel step for the normal gradient, in uv. One texel at `u_lod`. */
    u_texel: vec2<f32>,
    u_pad: vec2<f32>,
};
@group(0) @binding(0) var<uniform> u_disp: MeshDisplaceUniforms;

// Flat `array<f32>`, not a struct: `array<f32>` has a 4-byte stride and no alignment rules to get wrong,
// and it is already the shape the vertex buffer is in. A struct of vec2 + vec3 would pad to 32 bytes and
// silently disagree with the interleaved layout the render pipeline reads.
@group(0) @binding(1) var<storage, read> u_srcVerts: array<f32>;
@group(0) @binding(2) var<storage, read> u_srcIndices: array<u32>;
/**
 * Per-base-vertex displacement uv and normal, SHARED ACROSS A UV SEAM. Stride 5: uv.xy, normal.xyz.
 *
 * The one thing the implicit grid cannot be crack-free without. A uv seam splits a vertex; the copies
 * sit at one position carrying different uvs, so without this they sample different heights and move
 * apart — and 36.3% of the positions on the scan this was written for are uv seams. See
 * `buildDisplaceAttributes` in systems/meshDisplace.ts.
 */
@group(0) @binding(3) var<storage, read> u_srcDisplace: array<f32>;
@group(0) @binding(4) var<storage, read_write> u_outVerts: array<f32>;
@group(0) @binding(5) var u_height_texture: texture_2d<f32>;
@group(0) @binding(6) var u_height_sampler: sampler;

/** The field at an explicit mip, 1 at the top of the relief and 0 at its floor. */
fn heightAt2(uv: vec2<f32>, lod: f32) -> f32 {
    let r = textureSampleLevel(u_height_texture, u_height_sampler, uv, lod).r;
    return select(r, 1.0 - r, u_disp.u_invert != 0);
}

/** The field at the band-limited mip the caller chose. */
fn heightAt(uv: vec2<f32>) -> f32 {
    return heightAt2(uv, u_disp.u_lod);
}

/**
 * Invert the slot layout `tessSlot` produces: row `j` starts at `j * (2n + 3 - j) / 2`.
 *
 * Rows are barycentric and laid out longest-first, so this is a triangular-number inversion rather than
 * a divide. Solved by walking rows: `n` is at most 16, so at most 17 iterations, and a closed-form
 * quadratic root would cost an `sqrt` and a precision argument for the same answer.
 */
fn slotToIJ(slot: u32, n: u32) -> vec2<u32> {
    var j: u32 = 0u;
    var start: u32 = 0u;
    loop {
        let rowLen = n - j + 1u;
        if (slot < start + rowLen) { break; }
        start += rowLen;
        j += 1u;
        if (j > n) { break; }
    }
    return vec2<u32>(slot - start, j);
}

/** One vertex attribute out of the interleaved source buffer. */
fn srcVec3(vertex: u32, offset: u32) -> vec3<f32> {
    let b = vertex * u_disp.u_stride + offset;
    return vec3<f32>(u_srcVerts[b], u_srcVerts[b + 1u], u_srcVerts[b + 2u]);
}
fn srcVec2(vertex: u32, offset: u32) -> vec2<f32> {
    let b = vertex * u_disp.u_stride + offset;
    return vec2<f32>(u_srcVerts[b], u_srcVerts[b + 1u]);
}

// MODEL_VERTEX_LAYOUT, in floats: position 0, normal 3, uv 6, tangent 8, bitangent 11.
const OFF_POSITION: u32 = 0u;
const OFF_NORMAL: u32 = 3u;
const OFF_UV: u32 = 6u;
const OFF_TANGENT: u32 = 8u;
const OFF_BITANGENT: u32 = 11u;

// 64 invocations per workgroup — one dimension, because the work is a flat list of output vertices and
// a 2D grid would only add an index calculation.
@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let total = u_disp.u_triangleCount * u_disp.u_vertsPerTri;
    // The dispatch rounds its workgroup count up, so the tail must not write past the buffer.
    if (gid.x >= total) { return; }

    let tri = gid.x / u_disp.u_vertsPerTri;
    let slot = gid.x % u_disp.u_vertsPerTri;
    let n = u_disp.u_segments;
    let ij = slotToIJ(slot, n);

    // BARYCENTRIC WEIGHTS, and the reason no vertex needs deduplicating. Two input triangles sharing an
    // edge generate the same weights along it, and every term below is interpolated from the two shared
    // endpoints — so both copies land on the same displaced point without ever being welded. It is the
    // same reason hardware tessellation is watertight when its edge factors match.
    let fn_ = f32(n);
    let w1 = f32(ij.x) / fn_;
    let w2 = f32(ij.y) / fn_;
    let w0 = 1.0 - w1 - w2;

    let i0 = u_srcIndices[tri * 3u];
    let i1 = u_srcIndices[tri * 3u + 1u];
    let i2 = u_srcIndices[tri * 3u + 2u];

    let position = srcVec3(i0, OFF_POSITION) * w0 + srcVec3(i1, OFF_POSITION) * w1
                 + srcVec3(i2, OFF_POSITION) * w2;
    let uv = srcVec2(i0, OFF_UV) * w0 + srcVec2(i1, OFF_UV) * w1 + srcVec2(i2, OFF_UV) * w2;
    let tangent = srcVec3(i0, OFF_TANGENT) * w0 + srcVec3(i1, OFF_TANGENT) * w1
                + srcVec3(i2, OFF_TANGENT) * w2;
    let bitangent = srcVec3(i0, OFF_BITANGENT) * w0 + srcVec3(i1, OFF_BITANGENT) * w1
                  + srcVec3(i2, OFF_BITANGENT) * w2;

    // The SEAM-SAFE uv and normal, not the interleaved ones. Interpolating the vertex buffer's own uv
    // would sample a different height on each side of a seam and tear the mesh along it.
    let d0 = i0 * 5u; let d1 = i1 * 5u; let d2 = i2 * 5u;
    let dispUv = vec2<f32>(u_srcDisplace[d0], u_srcDisplace[d0 + 1u]) * w0
               + vec2<f32>(u_srcDisplace[d1], u_srcDisplace[d1 + 1u]) * w1
               + vec2<f32>(u_srcDisplace[d2], u_srcDisplace[d2 + 1u]) * w2;
    let rawNormal = vec3<f32>(u_srcDisplace[d0 + 2u], u_srcDisplace[d0 + 3u], u_srcDisplace[d0 + 4u]) * w0
                  + vec3<f32>(u_srcDisplace[d1 + 2u], u_srcDisplace[d1 + 3u], u_srcDisplace[d1 + 4u]) * w1
                  + vec3<f32>(u_srcDisplace[d2 + 2u], u_srcDisplace[d2 + 3u], u_srcDisplace[d2 + 4u]) * w2;
    // Interpolating three unit vectors shortens the result; a zero here would be a NaN normal.
    let nLen2 = dot(rawNormal, rawNormal);
    let normal = select(vec3<f32>(0.0, 1.0, 0.0), rawNormal * inverseSqrt(max(nLen2, 1e-30)),
                        nLen2 > 1e-20);

    // Any uv gives the same answer at a 1x1 mip; passing the fragment's own keeps it a plain sample.
    let mean = heightAt2(dispUv, u_disp.u_meanLod);
    let h = heightAt(dispUv) - mean;
    let displaced = position + normal * (h * u_disp.u_depth);

    // THE NORMAL, from the height GRADIENT rather than from adjacency.
    //
    // A gather over neighbouring output triangles would need an adjacency buffer and a second pass; the
    // surface is a height field over this one, so its normal is available analytically from two finite
    // differences at the same mip. Perturb the base normal by the gradient expressed in the tangent
    // frame — the standard bump-from-height construction, and smooth rather than faceted.
    //
    // The frame used here is the VERTEX one, which is legitimate at this scale: the chart's skew matters
    // to a per-fragment ray march (see chunks/parallax.wgsl) but a gradient only needs the two directions
    // u and v increase in, and the interpolated tangent/bitangent carry those.
    let du = (heightAt(dispUv + vec2<f32>(u_disp.u_texel.x, 0.0))
            - heightAt(dispUv - vec2<f32>(u_disp.u_texel.x, 0.0))) * 0.5;
    let dv = (heightAt(dispUv + vec2<f32>(0.0, u_disp.u_texel.y))
            - heightAt(dispUv - vec2<f32>(0.0, u_disp.u_texel.y))) * 0.5;
    // Scaled by depth over the world size of one texel step, so the slope is a real gradient rather than
    // a number that changes meaning with the map's resolution.
    let tLen = max(length(tangent), 1e-8);
    let bLen = max(length(bitangent), 1e-8);
    let slopeU = (du * u_disp.u_depth) / (u_disp.u_texel.x * tLen * tLen);
    let slopeV = (dv * u_disp.u_depth) / (u_disp.u_texel.y * bLen * bLen);
    let perturbed = normal - tangent * slopeU - bitangent * slopeV;
    let pLen2 = dot(perturbed, perturbed);
    let outNormal = select(normal, perturbed * inverseSqrt(max(pLen2, 1e-30)), pLen2 > 1e-20);

    let o = gid.x * u_disp.u_stride;
    u_outVerts[o + OFF_POSITION] = displaced.x;
    u_outVerts[o + OFF_POSITION + 1u] = displaced.y;
    u_outVerts[o + OFF_POSITION + 2u] = displaced.z;
    u_outVerts[o + OFF_NORMAL] = outNormal.x;
    u_outVerts[o + OFF_NORMAL + 1u] = outNormal.y;
    u_outVerts[o + OFF_NORMAL + 2u] = outNormal.z;
    u_outVerts[o + OFF_UV] = uv.x;
    u_outVerts[o + OFF_UV + 1u] = uv.y;
    u_outVerts[o + OFF_TANGENT] = tangent.x;
    u_outVerts[o + OFF_TANGENT + 1u] = tangent.y;
    u_outVerts[o + OFF_TANGENT + 2u] = tangent.z;
    u_outVerts[o + OFF_BITANGENT] = bitangent.x;
    u_outVerts[o + OFF_BITANGENT + 1u] = bitangent.y;
    u_outVerts[o + OFF_BITANGENT + 2u] = bitangent.z;
}

// ---------------------------------------------------------------------------------------------
// Clustered light lookup: which lights reach THIS fragment, out of however many the scene has.
//
// This is what replaced `u_pointLights: array<PointLight, 16>` and `u_spotlights: array<SpotLight, 8>`
// in the four lighting blocks. Those were not a performance budget — they were the size of a std140
// uniform array, hand-matched in eight files, and a scene's seventeenth point light was simply
// dropped. Every fragment also looped over every light in the scene, including the ones on the other
// side of the level that its own falloff guarantees contribute exactly nothing.
//
// The frustum is diced into a grid, uniform across the screen and exponential in depth, and the CPU
// assigns each light to the clusters its bounding sphere touches (see `graphics/clusters.ts`). A
// fragment finds its own cluster from `gl_FragCoord` and its view depth, and loops over that
// cluster's list alone.
//
// EVERYTHING ARRIVES IN ONE rgba32float TEXTURE, read with `textureLoad` and never sampled. WebGL2
// has no storage buffers at all, so a `var<storage>` light list would exist on one backend only; a
// uniform block is capped at 16 KB by ES 3.0 and is the thing being escaped. The layout, the region
// offsets and the packing all live in `graphics/lightData.ts`, which is where to change them.
//
// ONE RECORD SHAPE FOR BOTH LIGHT TYPES, and consequently one loop with no branch in it. A point
// light is uploaded as a spot whose cone covers everything — `coneScale = 0`, `coneOffset = 1`, so
// `spotAttenuation` returns `saturate(0 * cos + 1)^2`, which is exactly 1.0. `evaluatePointLight`
// and `evaluateSpotLight` differ by that one factor and nothing else, and multiplying by 1.0 is
// exact in IEEE, so a point light shaded down the spot path is BIT-IDENTICAL to one shaded by
// `evaluatePointLight`. That function still exists because custom materials can call it; nothing in
// the engine does any more.
//
// The two SHADOW slots are handled the same way. A light carries a spot atlas layer or a point cube
// slot, never both, and the other is -1 — which `spotShadow` and `pointShadow` each already treat as
// "unshadowed" on their own first line. Taking the max of the two lookups is therefore exact, and it
// is cheaper than branching: a cluster mixes light types, so a branch would diverge across the wave
// and cost both sides regardless. That is also why the record carries no light-type field at all.
//
// This chunk deliberately owns the ACCESSORS and not the loop. The loop body genuinely differs per
// path — forward PBR multiplies the sun by a parallax self-shadow, Blinn-Phong is a different shading
// model entirely, terrain has no shadow maps bound — while the parts that would drift dangerously if
// copied (the texel arithmetic, the slice function, the record layout) are all here, exactly once.
// The falloff and the BRDF were already shared, in chunks/pbrLighting.wgsl, and are untouched.
//
// Include AFTER chunks/pbrLighting.wgsl: `SpotLight` comes from there.
// ---------------------------------------------------------------------------------------------

/**
 * Everything needed to turn a fragment into a cluster, plus where the three regions of the data
 * texture begin.
 *
 * All of it is pre-solved on the CPU. The tile mapping and the depth slicing are each a multiply-add
 * here and a division, a logarithm and a backend conditional there — the same reasoning that puts a
 * spot light's cone in the uniform as `coneScale` / `coneOffset` rather than as two angles.
 */
struct ClusterUniforms {
    /** `tile = fragCoord.xy * scale + bias`. Absorbs the backends' opposite Y origins; see clusters.ts. */
    u_clusterTileScale: vec2<f32>,
    u_clusterTileBias: vec2<f32>,
    /** Clusters across, down, and into the distance. */
    u_clusterDim: vec3<i32>,
    /** `slice = log(viewDepth) * scale + bias`, the exponential subdivision. */
    u_clusterZScale: f32,
    u_clusterZBias: f32,
    /** `width - 1` and `log2(width)` of the data texture, so a texel index is a mask and a shift. */
    u_lightDataMask: i32,
    u_lightDataShift: i32,
    /** First texel of each region. Zero, then the records, then the index list. */
    u_clusterTableTexel: i32,
    u_lightRecordTexel: i32,
    u_lightIndexTexel: i32,
};
@group(1) @binding(6) var<uniform> u_cluster: ClusterUniforms;

// No sampler beside it, deliberately, and binding 1 is left empty: `textureLoad` takes none, an
// unreferenced binding is dropped from the auto-generated WebGPU layout, and an entry count that
// disagrees with the layout invalidates the whole command buffer. See cloudUpsample.wgsl, which
// documents the same trap at length.
@group(4) @binding(0) var u_lightData_texture: texture_2d<f32>;

/**
 * One texel of the data texture, by linear index.
 *
 * The row width is a power of two so this is a mask and a shift rather than a modulo and a divide —
 * a light record is four fetches and a cluster can hold dozens, so an integer division here is paid
 * tens of times per fragment.
 *
 * `u32` on the shift amount is not decoration: WGSL requires the right operand of `<<` and `>>` to be
 * unsigned whatever the left operand is, and naga rejects the module outright without it.
 */
fn cleoLightTexel(i: i32) -> vec4<f32> {
    let x = i & u_cluster.u_lightDataMask;
    let y = i >> u32(u_cluster.u_lightDataShift);
    return textureLoad(u_lightData_texture, vec2<i32>(x, y), 0);
}

/**
 * The cluster this fragment falls in.
 *
 * `viewDepth` is the distance in FRONT of the camera, positive — the same quantity the cascade
 * selection already computes as `-(u_view * vec4(fragPos, 1)).z`, so no path pays for it twice.
 *
 * Both clamps are load-bearing rather than defensive. A fragment exactly on the far plane lands one
 * slice past the end, and a fragment on the last row lands one tile past it once the Y flip has been
 * applied; without the clamps either reads a cluster belonging to some other part of the screen.
 */
fn cleoClusterOf(fragXY: vec2<f32>, viewDepth: f32) -> i32 {
    let tile = vec2<i32>(floor(fragXY * u_cluster.u_clusterTileScale + u_cluster.u_clusterTileBias));
    let x = clamp(tile.x, 0, u_cluster.u_clusterDim.x - 1);
    let y = clamp(tile.y, 0, u_cluster.u_clusterDim.y - 1);

    let raw = i32(floor(log(max(viewDepth, 1e-4)) * u_cluster.u_clusterZScale
                        + u_cluster.u_clusterZBias));
    let z = clamp(raw, 0, u_cluster.u_clusterDim.z - 1);

    // Slice-major, matching `clusterIndex` in clusters.ts.
    return x + u_cluster.u_clusterDim.x * (y + u_cluster.u_clusterDim.y * z);
}

/** Where this cluster's run of light indices begins, in ENTRIES. */
fn cleoClusterOffset(cluster: i32) -> i32 {
    return i32(cleoLightTexel(u_cluster.u_clusterTableTexel + cluster).x);
}

/** How many lights this cluster holds. Zero is the common case and costs one fetch. */
fn cleoClusterCount(cluster: i32) -> i32 {
    return i32(cleoLightTexel(u_cluster.u_clusterTableTexel + cluster).y);
}

/**
 * The light index at one entry of the packed list.
 *
 * Four indices ride in one rgba texel, so the entry number splits into a texel and a component. The
 * shift and mask are constants here rather than uniforms because four channels is a property of the
 * format, not of the layout.
 */
fn cleoClusterLight(entry: i32) -> i32 {
    let texel = cleoLightTexel(u_cluster.u_lightIndexTexel + (entry >> 2));
    let lane = entry & 3;
    // A dynamic index into a vector is legal WGSL but translates poorly; the select chain is what
    // every backend compiles into a pair of cmovs.
    var value = texel.x;
    if (lane == 1) { value = texel.y; }
    else if (lane == 2) { value = texel.z; }
    else if (lane == 3) { value = texel.w; }
    return i32(value);
}

/** A decoded light, plus the two things the `SpotLight` struct has no room for. */
struct ClusteredLight {
    light: SpotLight,
    /** Spot shadow atlas layer, or -1. Never set at the same time as `pointShadowSlot`. */
    spotShadowLayer: i32,
    /** Point shadow cube slot, or -1. */
    pointShadowSlot: i32,
};

/**
 * Unpack one light record: four texels, in the order `lightData.ts` writes them.
 *
 * Both light types decode into a `SpotLight`, which is the superset. A point light's cone is inert
 * by construction, not by a branch here — see the note at the top of this file.
 */
fn cleoLight(index: i32) -> ClusteredLight {
    let base = u_cluster.u_lightRecordTexel + index * 4;
    let t0 = cleoLightTexel(base);
    let t1 = cleoLightTexel(base + 1);
    let t2 = cleoLightTexel(base + 2);
    let t3 = cleoLightTexel(base + 3);

    var out: ClusteredLight;
    out.light.position = t0.xyz;
    out.light.invRangeSquared = t0.w;
    out.light.color = t1.xyz;
    out.light.intensity = t1.w;
    out.light.direction = t2.xyz;
    out.light.sourceRadius = t2.w;
    out.light.coneScale = t3.x;
    out.light.coneOffset = t3.y;
    out.spotShadowLayer = i32(t3.z);
    out.pointShadowSlot = i32(t3.w);
    return out;
}

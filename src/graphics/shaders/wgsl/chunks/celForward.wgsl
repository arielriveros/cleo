// Forward Cel (toon) shading, shared by the plain and skinned programs.
//
// Uses the light STRUCTS from chunks/pbrLighting.wgsl (the same lights feed every material model) but
// none of its BRDF. This is not a physical response at all: the Lambert term is QUANTIZED into flat
// bands, the specular lobe is THRESHOLDED into a hard shape, and a rim term is added that no light in
// the scene contributes to. The point is a stylized look, not an accurate one.
//
// Uses VertexOutput and tbnOf() without including chunks/modelVarying.wgsl: whichever vertex chunk the
// program included already brought them in, and a second definition is a compile error.
//
// Deliberately declares NO `u_envMap`. Cel has no reflection to author, and leaving the cube out means
// `_materialTextureFields` returns five plain names, `_materialBindGroup` never has to fill the `null`
// entry the env cube occupies for Blinn-Phong and PBR, and the per-draw env gate in the renderer does
// not need a cel arm.

@group(0) @binding(0) var u_material_baseTexture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_material_baseTexture_sampler: sampler;
// SECOND on purpose. Group 0 is filled in reflection source order, and the renderer's legacy
// `_textureSlot` table puts `rampMap` on texture unit 1 — the unit Blinn-Phong and PBR spend on their
// packed ORM / specular-reflectivity map, which a cel material can never carry (systems/texturePacker.ts
// switches on the material type and has no cel case, so it packs nothing). Declaring the ramp second
// makes the RHI's reflected order and the legacy unit agree.
@group(0) @binding(2) var u_material_rampMap_texture: texture_2d<f32>;
@group(0) @binding(3) var u_material_rampMap_sampler: sampler;
@group(0) @binding(4) var u_material_emissiveMap_texture: texture_2d<f32>;
@group(0) @binding(5) var u_material_emissiveMap_sampler: sampler;
@group(0) @binding(6) var u_material_normalMap_texture: texture_2d<f32>;
@group(0) @binding(7) var u_material_normalMap_sampler: sampler;
@group(0) @binding(8) var u_material_maskMap_texture: texture_2d<f32>;
@group(0) @binding(9) var u_material_maskMap_sampler: sampler;

struct CelMaterial {
    diffuse: vec3<f32>,
    ambient: vec3<f32>,
    /** Tint of the hard highlight. Not a reflectance — nothing here is energy-conserving. */
    specular: vec3<f32>,
    emissive: vec3<f32>,
    rimColor: vec3<f32>,
    /** HDR headroom for the emissive colour, default 1. See chunks/pbrGBuffer.wgsl for why. */
    emissiveIntensity: f32,
    /** Width of the Blinn lobe that `specularThreshold` then cuts. */
    shininess: f32,
    opacity: f32,
    /** Cutout threshold for the mask; 0 disables it. See chunks/basicGBuffer.wgsl. */
    alphaCutoff: f32,
    /**
     * Edge width, as a FRACTION OF ONE BAND rather than an absolute — so the same number means the same
     * thing at three bands and at eight. Shared by the band edges, the specular cut and the rim cut, so
     * one control softens the whole material consistently.
     */
    bandSoftness: f32,
    /** The lobe value the hard highlight cuts at. Higher is a smaller highlight. */
    specularThreshold: f32,
    /** Fresnel exponent. Higher is a tighter rim. */
    rimPower: f32,
    rimStrength: f32,
    // Every flag is an i32: WGSL forbids bool in a uniform buffer. Call sites still pass booleans.
    /** Step count for the quantizer. Ignored entirely when hasRampMap != 0. */
    bands: i32,
    hasBaseTexture: i32,
    hasRampMap: i32,
    hasEmissiveMap: i32,
    hasNormalMap: i32,
    hasMaskMap: i32,
};
@group(1) @binding(1) var<uniform> u_material: CelMaterial;

struct CelLighting {
    u_view: mat4x4<f32>,        // only to get the view-space depth that selects a cascade
    u_dirLight: DirectionalLight,
    u_skyLight: SkyLight,
    u_viewPos: vec3<f32>,
    /** Scene-wide indirect fill, in internal radiance units. Replaces the per-light ambient. */
    u_sceneAmbient: vec3<f32>,
};
@group(1) @binding(3) var<uniform> u_lighting: CelLighting;

/**
 * Half-width of every soft edge in this material, from the one `bandSoftness` control.
 *
 * Clamped to 0..1 before halving, so a hand-edited asset carrying a negative or oversized value cannot
 * hand `smoothstep` an inverted pair (edge0 > edge1), which is not defined to do anything sensible.
 * Floored at 1e-4 because edge0 == edge1 is indeterminate, and 0 is where the inspector's slider stops.
 */
fn celEdgeWidth() -> f32 {
    return max(clamp(u_material.bandSoftness, 0.0, 1.0) * 0.5, 1e-4);
}

/**
 * Quantize 0..1 into `bands` steps with a softened edge.
 *
 * DERIVATIVE-FREE ON PURPOSE, and this is a hard constraint rather than a preference. The obvious
 * antialiasing here is `fwidth`, and it cannot be used: this runs inside the clustered punctual-light
 * loop, whose trip count varies per pixel, and an implicit derivative in non-uniform control flow is a
 * WGSL uniformity error. naga rejects the whole module, so it fails the BUILD, not the frame.
 * `bandSoftness` is an analytic width instead.
 *
 * The steps SPAN 0..1 — with three bands they are 0, 0.5 and 1, not 0, 1/3 and 2/3. Dividing by the band
 * count is the obvious way to write this and it is wrong: the top band would land at (n-1)/n, so a
 * surface facing the light dead-on would return 0.667 of its own diffuse colour and every cel material
 * would read as darker than the same albedo under any other shading model, for a reason nothing in the
 * inspector explains. Dividing by the gaps BETWEEN the bands puts the last one at exactly 1.
 *
 * `min(floor(x), n - 1)` is what makes t = 1.0 land in the last band instead of in a band past the end:
 * `floor(1.0 * n)` is n, not n - 1.
 *
 * One band is the degenerate case and returns 1: a single step has no variation to show, so the surface
 * should read as lit rather than as black.
 *
 * The soft edge is capped at half a band, so raising softness can never merge two bands into one, and
 * floored at 1e-4, because smoothstep with edge0 == edge1 is indeterminate. It runs at the TOP of each
 * band, blending into the next; on the last band there is no next, and the clamp absorbs it.
 */
fn celQuantize(t: f32) -> f32 {
    let n = f32(max(u_material.bands, 1));
    if (n <= 1.0) { return 1.0; }
    let x = clamp(t, 0.0, 1.0) * n;
    let index = min(floor(x), n - 1.0);
    let frac = x - floor(x);
    let w = celEdgeWidth();
    return clamp((index + smoothstep(1.0 - w, 1.0, frac)) / (n - 1.0), 0.0, 1.0);
}

/**
 * The band curve as a COLOUR — the ramp texture when one is assigned, the numeric bands otherwise. A
 * ramp lets the light response be authored as a gradient, including a hue shift into shadow that no
 * number of bands can express.
 *
 * `textureSampleLevel`, never `textureSample`, for the same reason celQuantize takes no derivatives: an
 * implicit LOD needs derivatives, and this is called from non-uniform control flow. A ramp is a 1-D
 * gradient with no useful mip chain, so an explicit level 0 costs nothing.
 *
 * Sampled at v = 0.5 so a one-pixel strip and a square gradient both work, and mapped onto TEXEL
 * CENTRES rather than onto 0..1 directly. That inset is what makes the lookup independent of the
 * texture's wrap mode: at u = 1 a repeat-wrapped ramp blends into its own first texel, so the brightest
 * band picks up a fringe of the darkest one — and the editor's texture uploader assigns
 * `wrapping: 'repeat'`, so an author cannot be relied on to have avoided it. Half a texel in from each
 * end also means the two end bands are sampled as authored rather than half-blended with nothing.
 *
 * `textureDimensions` takes no derivatives, so it is legal in the non-uniform control flow this runs in.
 */
fn celRamp(t: f32) -> vec3<f32> {
    let x = clamp(t, 0.0, 1.0);
    if (u_material.hasRampMap != 0) {
        let w = f32(textureDimensions(u_material_rampMap_texture, 0).x);
        let u = (x * (w - 1.0) + 0.5) / w;
        return toLinear(textureSampleLevel(u_material_rampMap_texture, u_material_rampMap_sampler,
                                           vec2<f32>(u, 0.5), 0.0).rgb);
    }
    return vec3<f32>(celQuantize(x));
}

/** A hard-edged highlight: the Blinn lobe THRESHOLDED rather than used as a magnitude. */
fn celSpecular(NoH: f32) -> f32 {
    let lobe = pow(max(NoH, 0.0), max(u_material.shininess, 1.0));
    let w = celEdgeWidth();
    return smoothstep(u_material.specularThreshold - w, u_material.specularThreshold + w, lobe);
}

// Per-light functions return direct diffuse + specular only. Ambient is applied once in the entry point
// (a single term), not accumulated per light — otherwise ambient scales with the light count.
//
// THE SHADOW IS FOLDED INTO N·L BEFORE THE QUANTIZER, not banded beside it. A separately banded shadow
// multiplied by a banded diffuse lays a second staircase across the first, and the two never line up:
// you get four muddy values through the terminator instead of one hard edge. Folding puts the shadow
// edge ON a band boundary by construction, which is the whole visual point.

fn computeDirectionalLight(fragPos: vec3<f32>, normal: vec3<f32>, viewDir: vec3<f32>,
                           light: DirectionalLight,
                           materialDiffuse: vec3<f32>, materialSpecular: vec3<f32>) -> vec3<f32> {
    if (dot(light.direction, light.direction) <= 1e-6) { return vec3<f32>(0.0); }
    let radiance = light.color * light.intensity;

    let viewDepth = -(u_lighting.u_view * vec4<f32>(fragPos, 1.0)).z;
    let visibility = 1.0 - directionalShadow(fragPos, normal, viewDepth);

    let lambert = max(dot(normal, -light.direction), 0.0) * visibility;
    let halfwayDir = normalize(-light.direction + viewDir);
    let spec = celSpecular(dot(normal, halfwayDir)) * visibility;

    return radiance * (celRamp(lambert) * materialDiffuse + spec * materialSpecular);
}

/**
 * One clustered punctual light. Both types come through here.
 *
 * The point-light twin this used to sit beside is gone. A point light is uploaded as a spot whose
 * cone covers everything (`coneScale = 0`, `coneOffset = 1`), and `spotAttenuation` then returns
 * exactly 1.0 — so the two functions computed the same number for it, one of them via a multiply by
 * one. See chunks/clusteredLights.wgsl.
 *
 * `attenuation` and `cone` stay OUTSIDE the quantizer, unlike the shadow. Banding a point light's
 * inverse-square falloff paints concentric rings across a flat floor, which reads as an artifact rather
 * than as style — the bands should follow the SHAPE of the surface, not its distance from a lamp.
 */
fn computePunctualLight(fragPos: vec3<f32>, normal: vec3<f32>, viewDir: vec3<f32>,
                        light: SpotLight, visibility: f32,
                        materialDiffuse: vec3<f32>, materialSpecular: vec3<f32>) -> vec3<f32> {
    let toLight = light.position - fragPos;
    let d2 = dot(toLight, toLight);
    let attenuation = distanceAttenuation(d2, light.invRangeSquared);
    if (attenuation <= 0.0) { return vec3<f32>(0.0); }

    let lightDir = normalize(toLight);
    let cone = spotAttenuation(dot(lightDir, normalize(-light.direction)), light.coneScale, light.coneOffset);

    let lambert = max(dot(normal, lightDir), 0.0) * visibility;
    let halfwayDir = normalize(lightDir + viewDir);
    let spec = celSpecular(dot(normal, halfwayDir)) * visibility;

    let radiance = light.color * (light.intensity * attenuation * cone);
    return radiance * (celRamp(lambert) * materialDiffuse + spec * materialSpecular);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // The shadow library reads the fragment coordinate through a module-scope global, because only an
    // entry point receives @builtin(position). Publish it before calling in.
    cleoFragCoord = in.position.xy;

    let fragPos = in.fragPos;
    let tbn = tbnOf(in);

    // `alphaCutoff`, the per-material threshold shared with Basic, Blinn-Phong and PBR. Material.Cel
    // defaults it to 0.5 whenever a mask is present and to 0 when there is none, and `parse` applies the
    // same rule, so a cutout behaves identically across every shading model.
    if (u_material.hasMaskMap != 0 && u_material.alphaCutoff > 0.0) {
        let mask = textureSample(u_material_maskMap_texture, u_material_maskMap_sampler, in.uv).r;
        if (mask < u_material.alphaCutoff) { discard; }
    }

    var normal = tbn[2];
    let viewDir = normalize(u_lighting.u_viewPos - fragPos);

    if (u_material.hasNormalMap != 0) {
        var n = textureSample(u_material_normalMap_texture, u_material_normalMap_sampler, in.uv).rgb;
        n = normalize(n * 2.0 - 1.0);
        normal = normalize(tbn * n);
    }

    // Decode the sRGB base colour once to linear; reuse it for both diffuse and ambient tints.
    var baseTex = vec3<f32>(1.0);
    if (u_material.hasBaseTexture != 0) {
        baseTex = toLinear(textureSample(u_material_baseTexture_texture,
                                         u_material_baseTexture_sampler, in.uv).rgb);
    }

    let matAmbient = u_material.ambient * baseTex;
    let matDiffuse = u_material.diffuse * baseTex;
    let matSpecular = u_material.specular;

    // Single ambient term: the SCENE ambient plus its sky light, against the material's own ambient
    // tint. Zeroed when the scene sets neither. NOT quantized — it has no direction to band along, and
    // it is what keeps the darkest band from being pure black.
    var result = (u_lighting.u_sceneAmbient
                  + skyIrradiance(u_lighting.u_skyLight, normal)) * matAmbient;

    result += computeDirectionalLight(fragPos, normal, viewDir, u_lighting.u_dirLight,
                                      matDiffuse, matSpecular);

    // Every punctual light that reaches THIS fragment. `u_view` is in the block for the cascade
    // depth already, so the cluster lookup costs one transform that was being paid regardless.
    let clusterDepth = -(u_lighting.u_view * vec4<f32>(fragPos, 1.0)).z;
    let cluster = cleoClusterOf(cleoFragCoord, clusterDepth);
    let first = cleoClusterOffset(cluster);
    let count = cleoClusterCount(cluster);
    for (var i = 0; i < count; i++) {
        let cl = cleoLight(cleoClusterLight(first + i));
        result += computePunctualLight(fragPos, normal, viewDir, cl.light,
                                       cleoPunctualVisibility(cl.spotShadowLayer, cl.pointShadowSlot,
                                                              fragPos, normal, cl.light.position),
                                       matDiffuse, matSpecular);
    }

    // Rim, once, additive, and outside every light. A rim light in this model is an artistic control
    // rather than a physical response, so it does not scale with any light in the scene — it survives
    // even a fragment no light reaches, which is exactly what separates a character from its background.
    let rimW = celEdgeWidth();
    let fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), max(u_material.rimPower, 0.001));
    result += smoothstep(0.5 - rimW, 0.5 + rimW, fresnel) * u_material.rimStrength * u_material.rimColor;

    // Emissive (sRGB-decoded map). Output stays LINEAR HDR — tonemap and gamma happen at the present.
    if (u_material.hasEmissiveMap != 0) {
        result += toLinear(textureSample(u_material_emissiveMap_texture, u_material_emissiveMap_sampler,
                                         in.uv).rgb)
                  * u_material.emissive * 1.25 * u_material.emissiveIntensity;
    } else {
        result += u_material.emissive * 1.25 * u_material.emissiveIntensity;
    }

    return vec4<f32>(result, u_material.opacity);
}

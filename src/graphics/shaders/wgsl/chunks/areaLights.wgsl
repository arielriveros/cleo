// ---------------------------------------------------------------------------------------------
// AREA LIGHTS: a glowing rectangle or disk, shaded by linearly transformed cosines (Heitz, Dupuy, Hill
// and Neubelt 2016, "Real-Time Polygonal-Light Shading with Linearly Transformed Cosines").
//
// The integral of a GGX lobe over a polygon has no closed form, but the integral of a COSINE over a
// polygon does (Lambert's edge formula), and a GGX lobe is, to a fitted approximation, a cosine pushed
// through a 3x3 matrix. So the polygon is pulled back through that matrix's inverse (the LTC table,
// indexed by roughness and view angle) and integrated as a cosine: an exact shape, an exact horizon, a
// highlight that is a picture of the panel. Diffuse is the same integral with no matrix at all, which is
// the polygon's exact form factor.
//
// Include AFTER chunks/pbrLighting.wgsl, chunks/clusteredLights.wgsl and chunks/shadows.wgsl: it reads
// `SpotLight`, the light data texture (`cleoLightTexel`) and the shadow lookups, and the include resolver
// has no include-once guard to pull them in itself.
//
// NOT part of the custom-material prelude (clusteredLightsChunk.wgsl / shadowsChunk.wgsl), and it must
// never be: the prelude is hashed into every stored custom shader. A path that does not include this
// shades an area light as the spot or point its record also is (lightData.ts), which is the graceful
// fallback the record was designed for.
// ---------------------------------------------------------------------------------------------

/** Side of each LTC table, and where the second one starts in the light data texture (both at its start). */
const CLEO_LTC_SIZE: i32 = 64;
const CLEO_LTC_TABLE_2: i32 = 4096;
/** Vertices of the polygon a disk is shaded as: an octagon of the disk's area. */
const CLEO_DISK_SIDES: i32 = 8;
/** sqrt(pi / (2 sqrt 2)): an octagon's circumradius over the radius of the disk of the same area. */
const CLEO_DISK_OCTAGON_SCALE: f32 = 1.0539;

struct CleoAreaLight {
    center: vec3<f32>,
    /** The emitting side's normal (the light's forward). */
    normal: vec3<f32>,
    /** Width axis. */
    tangent: vec3<f32>,
    /** Height axis: cross(normal, tangent), so the corners wind counter-clockwise seen from the front. */
    bitangent: vec3<f32>,
    halfWidth: f32,
    halfHeight: f32,
    /** The face's radiance: colour x intensity x radianceScale (pre-exposed, flicker in). */
    radiance: vec3<f32>,
    invRangeSquared: f32,
    /** 0 rect, 1 disk. */
    shape: i32,
    twoSided: bool,
};

/** The extension texel an area light's record names, or a negative number for a point or spot. */
fn cleoAreaIndex(cl: ClusteredLight) -> i32 {
    return -min(cl.spotShadowLayer, cl.pointShadowSlot) - 2;
}

/** Decode an area light from its record and its extension at texel `ext`. */
fn cleoAreaLight(cl: ClusteredLight, ext: i32) -> CleoAreaLight {
    let e0 = cleoLightTexel(ext);
    let e1 = cleoLightTexel(ext + 1);
    var a: CleoAreaLight;
    a.center = cl.light.position;
    a.normal = normalize(cl.light.direction);
    a.tangent = normalize(e0.xyz);
    a.bitangent = cross(a.normal, a.tangent);
    a.halfWidth = e0.w;
    a.halfHeight = e1.y;
    a.radiance = cl.light.color * (cl.light.intensity * e1.x);
    a.invRangeSquared = cl.light.invRangeSquared;
    a.shape = i32(e1.z + 0.5);
    a.twoSided = e1.w >= 0.5;
    return a;
}

/** The shadow lookup an area light carries: a spot map one-sided, a cube two-sided (the other field is its marker). */
fn cleoAreaVisibility(cl: ClusteredLight, a: CleoAreaLight, worldPos: vec3<f32>, N: vec3<f32>) -> f32 {
    let spot = select(cl.spotShadowLayer, -1, a.twoSided);
    let point = select(-1, cl.pointShadowSlot, a.twoSided);
    return cleoPunctualVisibility(spot, point, worldPos, N, a.center);
}

/** The windowed range falloff WITHOUT the inverse square: the form factor already carries the distance. */
fn cleoAreaWindow(a: CleoAreaLight, p: vec3<f32>) -> f32 {
    let d = p - a.center;
    let f = dot(d, d) * a.invRangeSquared;
    let w = saturate(1.0 - f * f);
    return w * w;
}

/** One texel of LTC table `table` (0 or 1), clamped to its edge. */
fn cleoLtcTexel(table: i32, x: i32, y: i32) -> vec4<f32> {
    let cx = clamp(x, 0, CLEO_LTC_SIZE - 1);
    let cy = clamp(y, 0, CLEO_LTC_SIZE - 1);
    return cleoLightTexel(table * CLEO_LTC_TABLE_2 + cy * CLEO_LTC_SIZE + cx);
}

/** Bilinear LTC lookup by perceptual roughness and NoV (rgba32float cannot be filtered on every device). */
fn cleoLtcLookup(table: i32, perceptual: f32, NoV: f32) -> vec4<f32> {
    let uv = vec2<f32>(saturate(perceptual), sqrt(saturate(1.0 - NoV))) * f32(CLEO_LTC_SIZE - 1);
    let base = floor(uv);
    let f = uv - base;
    let x = i32(base.x);
    let y = i32(base.y);
    let a = mix(cleoLtcTexel(table, x, y), cleoLtcTexel(table, x + 1, y), f.x);
    let b = mix(cleoLtcTexel(table, x, y + 1), cleoLtcTexel(table, x + 1, y + 1), f.x);
    return mix(a, b, f.y);
}

/** The polygon's vertex `i` (of 4 for a rect, 8 for a disk), counter-clockwise seen from the front. */
fn cleoAreaVertex(a: CleoAreaLight, i: i32) -> vec3<f32> {
    if (a.shape == 1) {
        let angle = f32(i) * (2.0 * PI / f32(CLEO_DISK_SIDES));
        let r = a.halfWidth * CLEO_DISK_OCTAGON_SCALE;
        return a.center + (a.tangent * cos(angle) + a.bitangent * sin(angle)) * r;
    }
    let sx = select(-1.0, 1.0, i == 1 || i == 2);
    let sy = select(-1.0, 1.0, i >= 2);
    return a.center + a.tangent * (sx * a.halfWidth) + a.bitangent * (sy * a.halfHeight);
}

/**
 * The vector form factor of edge (v1, v2), both on the unit sphere: `cross(v1, v2) * theta / sin(theta) / 2pi`,
 * theta / sin(theta) by a rational fit that stays accurate to the antipode (three.js's, after Hill).
 */
fn cleoLtcEdge(v1: vec3<f32>, v2: vec3<f32>) -> vec3<f32> {
    let x = dot(v1, v2);
    let y = abs(x);
    let a = 0.8543985 + (0.4965155 + 0.0145206 * y) * y;
    let b = 3.4175940 + (4.1616724 + y) * y;
    let v = a / b;
    let thetaSinTheta = select(0.5 * inverseSqrt(max(1.0 - x * x, 1e-7)) - v, v, x > 0.0);
    return cross(v1, v2) * thetaSinTheta;
}

/** The z of `cleoLtcEdge`: all the clipped polygon's integral needs. */
fn cleoLtcEdgeZ(v1: vec3<f32>, v2: vec3<f32>) -> f32 {
    return cleoLtcEdge(v1, v2).z;
}

/**
 * The light's polygon integrated against the cosine lobe `Minv` maps it into, at `P`, in the frame
 * (T1, T2, N): 1 for a polygon filling the hemisphere. The polygon is clipped to the lobe's horizon
 * (z >= 0) exactly — Sutherland-Hodgman, a convex polygon gains at most one vertex — and Lambert's edge
 * sum's z is the integral. (A sphere stand-in for the clipped part reads up to a third off where a panel
 * straddles a wall's plane, and some percent off even above the horizon.) A receiver behind a one-sided
 * light gets nothing; behind a two-sided one, the polygon wound the other way. areaLightMath.ts is the
 * CPU twin the tests hold to brute force.
 */
fn cleoLtcIntegrate(a: CleoAreaLight, P: vec3<f32>, T1: vec3<f32>, T2: vec3<f32>, N: vec3<f32>,
                    Minv: mat3x3<f32>) -> f32 {
    let behind = dot(a.normal, P - a.center) < 0.0;
    if (behind && !a.twoSided) { return 0.0; }
    // Into the lobe's space: the frame's transpose, then the inverse transform.
    let m = Minv * transpose(mat3x3<f32>(T1, T2, N));
    let n = select(4, CLEO_DISK_SIDES, a.shape == 1);
    var v: array<vec3<f32>, 8>;
    for (var i = 0; i < n; i++) {
        let k = select(i, n - 1 - i, behind);
        v[i] = m * (cleoAreaVertex(a, k) - P);
    }

    var first = vec3<f32>(0.0);
    var prev = vec3<f32>(0.0);
    var emitted = 0;
    var fz = 0.0;
    for (var i = 0; i < n; i++) {
        let p0 = v[i];
        let p1 = v[(i + 1) % n];
        let in0 = p0.z >= 0.0;
        if (in0) {
            let q = normalize(p0);
            if (emitted == 0) { first = q; } else { fz += cleoLtcEdgeZ(prev, q); }
            prev = q;
            emitted++;
        }
        if (in0 != (p1.z >= 0.0)) {
            let t = p0.z / (p0.z - p1.z);
            let cut = mix(p0, p1, t);
            let q = normalize(vec3<f32>(cut.xy, 0.0));
            if (emitted == 0) { first = q; } else { fz += cleoLtcEdgeZ(prev, q); }
            prev = q;
            emitted++;
        }
    }
    if (emitted < 3) { return 0.0; }
    fz += cleoLtcEdgeZ(prev, first);
    return max(fz, 0.0);
}

/** A tangent frame round N whose first axis lies in the plane of N and V (where the LTC fit is defined). */
fn cleoLtcFrame(N: vec3<f32>, V: vec3<f32>) -> mat3x3<f32> {
    var T1 = V - N * dot(V, N);
    if (dot(T1, T1) < 1e-8) {
        // Looking straight down the normal: any axis in the plane will do, the lobe is round there.
        T1 = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), abs(N.x) > 0.9);
        T1 = T1 - N * dot(T1, N);
    }
    T1 = normalize(T1);
    let T2 = -cross(N, T1);
    return mat3x3<f32>(T1, T2, N);
}

/**
 * One area light's reflected radiance at a surface: GGX specular through the LTC fit (with the paper's
 * Fresnel split and the multi-scatter compensation the punctual lights take) plus Lambert diffuse from the
 * exact form factor, times the range window and `visibility`.
 */
fn evaluateAreaLight(a: CleoAreaLight, P: vec3<f32>, N: vec3<f32>, V: vec3<f32>, albedo: vec3<f32>,
                     metallic: f32, roughness: f32, visibility: f32) -> vec3<f32> {
    let window = cleoAreaWindow(a, P);
    if (window <= 0.0 || visibility <= 0.0) { return vec3<f32>(0.0); }
    let NoV = clamp(dot(N, V), 1e-4, 1.0);
    let perceptual = max(roughness, MIN_PERCEPTUAL_ROUGHNESS);
    let frame = cleoLtcFrame(N, V);
    let t1 = cleoLtcLookup(0, perceptual, NoV);
    let t2 = cleoLtcLookup(1, perceptual, NoV);
    let Minv = mat3x3<f32>(vec3<f32>(t1.x, 0.0, t1.y), vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(t1.z, 0.0, t1.w));
    let identity = mat3x3<f32>(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(0.0, 0.0, 1.0));

    let specFF = cleoLtcIntegrate(a, P, frame[0], frame[1], frame[2], Minv);
    let diffFF = cleoLtcIntegrate(a, P, frame[0], frame[1], frame[2], identity);
    let f0 = mix(vec3<f32>(0.04), albedo, metallic);
    let fresnel = f0 * t2.x + (vec3<f32>(1.0) - f0) * t2.y;
    let specular = fresnel * (specFF * energyCompensation(f0, NoV, perceptual));
    let diffuse = albedo * ((1.0 - metallic) * diffFF);
    return (diffuse + specular) * a.radiance * (window * visibility);
}

/** Irradiance E (not E / pi) the light puts on a Lambertian surface at P facing N: pi x radiance x form factor. */
fn areaLightIrradiance(a: CleoAreaLight, P: vec3<f32>, N: vec3<f32>) -> vec3<f32> {
    let window = cleoAreaWindow(a, P);
    if (window <= 0.0) { return vec3<f32>(0.0); }
    let frame = cleoLtcFrame(N, N);
    let identity = mat3x3<f32>(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(0.0, 0.0, 1.0));
    return a.radiance * (PI * window * cleoLtcIntegrate(a, P, frame[0], frame[1], frame[2], identity));
}

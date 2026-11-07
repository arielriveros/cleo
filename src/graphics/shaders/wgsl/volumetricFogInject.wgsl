// Volumetric fog, pass 1: the medium in each froxel and the light it scatters. See
// chunks/volumetricFogCommon.wgsl for the scheme.

#include "./chunks/fullscreen.wgsl"
#include "./chunks/volumetricFogCommon.wgsl"
#include "./chunks/shadows.wgsl"
#include "./chunks/pbrLighting.wgsl"
#include "./chunks/clusteredLights.wgsl"

// Last frame's froxels, for the temporal blend.
@group(0) @binding(0) var u_history_texture: texture_2d<f32>;
@group(0) @binding(1) var u_history_sampler: sampler;

/** Henyey-Greenstein, normalised over the sphere. `cosTheta` between the light's travel and the view ray. */
fn hgPhase(cosTheta: f32, g: f32) -> f32 {
    let g2 = g * g;
    return (1.0 - g2) / (4.0 * FOG_PI * pow(max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4), 1.5));
}

fn hash31(p: vec3<f32>) -> f32 {
    let q = fract(p * vec3<f32>(0.1031, 0.1030, 0.0973));
    let r = q + dot(q, q.yxz + 33.33);
    return fract((r.x + r.y) * r.z);
}

/** Smooth 3D value noise in [0, 1]. */
fn valueNoise3(p: vec3<f32>) -> f32 {
    let i = floor(p);
    let f = p - i;
    let u = f * f * (3.0 - 2.0 * f);
    let a = mix(hash31(i), hash31(i + vec3<f32>(1.0, 0.0, 0.0)), u.x);
    let b = mix(hash31(i + vec3<f32>(0.0, 1.0, 0.0)), hash31(i + vec3<f32>(1.0, 1.0, 0.0)), u.x);
    let c = mix(hash31(i + vec3<f32>(0.0, 0.0, 1.0)), hash31(i + vec3<f32>(1.0, 0.0, 1.0)), u.x);
    let d = mix(hash31(i + vec3<f32>(0.0, 1.0, 1.0)), hash31(i + vec3<f32>(1.0, 1.0, 1.0)), u.x);
    return mix(mix(a, b, u.y), mix(c, d, u.y), u.z);
}

/** Two octaves of drifting noise, roughly in [0, 1]. */
fn fogNoise(p: vec3<f32>) -> f32 {
    return valueNoise3(p) * 0.65 + valueNoise3(p * 2.03 + 17.1) * 0.35;
}

/** One volume's feathered containment at `p` (as boxWeight in core/scene/nodes/boxVolume.ts), and its local point. */
fn volumeWeight(i: i32, p: vec3<f32>) -> vec4<f32> {
    let local = (u_fogv.u_volumeInv[i] * vec4<f32>(p, 1.0)).xyz;
    let blend = u_fogv.u_volumeD[i].xyz;
    var w = 1.0;
    for (var a = 0; a < 3; a++) {
        let edge = 0.5 - abs(local[a]);
        if (edge <= 0.0) { w = 0.0; }
        else if (blend[a] > 0.0) { w *= smoothstep(0.0, blend[a], edge); }
    }
    return vec4<f32>(local, w);
}

struct Medium {
    /** Scattering coefficient per channel (density x albedo), per metre. */
    scatter: vec3<f32>,
    extinction: f32,
    emission: vec3<f32>,
    /** Extinction-weighted mean anisotropy and scattering multipliers. */
    g: f32,
    sun: f32,
    local: f32,
    ambient: f32,
};

fn mediumAt(p: vec3<f32>) -> Medium {
    var m: Medium;
    m.scatter = vec3<f32>(0.0);
    m.extinction = 0.0;
    m.emission = vec3<f32>(0.0);
    m.g = 0.0;
    m.sun = 0.0;
    m.local = 0.0;
    m.ambient = 0.0;
    for (var i = 0; i < 16; i++) {
        if (i >= u_fogv.u_volumeCount) { break; }
        let lw = volumeWeight(i, p);
        if (lw.w > 0.0) {
            let a = u_fogv.u_volumeA[i];
            let b = u_fogv.u_volumeB[i];
            let c = u_fogv.u_volumeC[i];
            // Height: thinning from the box's bottom face up, in world metres.
            let height = (lw.y + 0.5) * a.w;
            var density = a.x * lw.w * exp(-a.z * max(height, 0.0));
            // Drifting noise breaks it up (wind in world metres per second).
            if (b.w > 0.0) {
                let q = (p - u_fogv.u_volumeE[i].xyz * u_fogv.u_time) / max(c.w, 0.05);
                density *= mix(1.0, saturate(fogNoise(q) * 1.6 - 0.15), b.w);
            }
            m.extinction += density;
            m.scatter += density * b.xyz;
            m.emission += c.xyz * lw.w;
            m.g += a.y * density;
            m.sun += u_fogv.u_volumeD[i].w * density;
            m.local += u_fogv.u_volumeE[i].w * density;
            m.ambient += u_fogv.u_volumeF[i].x * density;
        }
    }
    if (m.extinction > 0.0) {
        let inv = 1.0 / m.extinction;
        m.g *= inv;
        m.sun *= inv;
        m.local *= inv;
        m.ambient *= inv;
    }
    return m;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let fx = fogFroxelOf(in.position.xy);
    let grid = u_fogv.u_grid.xy;
    let uv = (vec2<f32>(fx.xy) + 0.5) / grid;
    // The shadow library's dither reads the fragment coordinate.
    cleoFragCoord = uv * u_fogv.u_renderSize;

    // This froxel's sample: its tile centre, at a depth jittered through the slice frame to frame, so the
    // temporal blend averages the whole cell rather than one plane of it.
    let dir = fogRayDir(uv);
    let along = max(dot(dir, u_fogv.u_camForward), 1e-3);
    let viewDepth = fogSliceDepth(f32(fx.z) + u_fogv.u_jitter);
    let p = u_fogv.u_camPos + dir * (viewDepth / along);

    let m = mediumAt(p);
    var light = m.emission;
    if (m.extinction > 0.0) {
        let V = -dir;   // toward the camera
        // The key light (the sun, or the moon at night), through the cascades it casts.
        let sunVis = shadowVisibility(p, viewDepth);
        // The phase angle is between the light's travel (-sunDir) and the view ray back to the camera (V):
        // looking toward the sun through the fog is the forward lobe.
        light += m.scatter * u_fogv.u_sunColor * (sunVis * hgPhase(dot(-u_fogv.u_sunDir, V), m.g) * m.sun);
        // The sky's fill, as isotropic radiance (irradiance / pi).
        light += m.scatter * u_fogv.u_ambient * (m.ambient / FOG_PI);
        // Every point and spot light whose cluster this froxel is in: the torches' halos.
        if (u_fogv.u_localLights != 0) {
            let cluster = cleoClusterOf(cleoFragCoord, viewDepth);
            let first = cleoClusterOffset(cluster);
            let count = cleoClusterCount(cluster);
            for (var i = 0; i < count; i++) {
                let cl = cleoLight(cleoClusterLight(first + i));
                if (cleoLightReaches(cl.light, p)) {
                    let toLight = cl.light.position - p;
                    let d2 = max(dot(toLight, toLight), cl.light.sourceRadius * cl.light.sourceRadius);
                    let L = toLight * inverseSqrt(max(dot(toLight, toLight), 1e-8));
                    let cone = spotAttenuation(dot(-L, cl.light.direction), cl.light.coneScale, cl.light.coneOffset);
                    var vis = 1.0;
                    // Through the light's own shadow map when it has one: a torch behind a wall lights none of
                    // the fog on this side of it. The "normal" is the direction to the light, so the bias
                    // offset steps toward it.
                    if (u_fogv.u_localShadows != 0) {
                        vis = cleoPunctualVisibility(cl.spotShadowLayer, cl.pointShadowSlot, p, L, cl.light.position);
                    }
                    let E = cl.light.color * (cl.light.intensity * distanceAttenuation(d2, cl.light.invRangeSquared) * cone * vis);
                    light += m.scatter * E * (hgPhase(dot(-L, V), m.g) * m.local);
                }
            }
        }
    }
    // Fog-only glow spheres (a particle system's fogGlow): a fire lighting its own smoke and the mist round it.
    for (var e = 0; e < 16; e++) {
        if (e >= u_fogv.u_emitterCount) { break; }
        let s = u_fogv.u_emitters[e];
        let toE = s.xyz - p;
        let d2 = max(dot(toE, toE), 0.01);
        let reach = saturate(1.0 - d2 / max(s.w * s.w, 1e-4));
        light += m.scatter * u_fogv.u_emitterColor[e].xyz * (reach * reach / d2 / (4.0 * FOG_PI));
    }
    var current = vec4<f32>(min(light, vec3<f32>(32768.0)), m.extinction);

    // Temporal: last frame's froxel at this point, through last frame's camera, rescaled to this frame's
    // pre-exposure. Rejected off screen and where the fog changed sharply (a torch flaring, a volume moved).
    if (u_fogv.u_historyWeight > 0.0) {
        let prevClip = u_fogv.u_prevViewProj * vec4<f32>(p, 1.0);
        if (prevClip.w > 0.0) {
            let prevUv = prevClip.xy / prevClip.w * 0.5 + 0.5;
            let prevDepth = -(u_fogv.u_prevView * vec4<f32>(p, 1.0)).z;
            if (all(prevUv >= vec2<f32>(0.0)) && all(prevUv <= vec2<f32>(1.0)) && prevDepth > u_fogv.u_near) {
                let h = fogSampleAtlas(u_history_texture, u_history_sampler, prevUv, fogDepthSlice(prevDepth));
                let history = vec4<f32>(h.rgb * u_fogv.u_historyRescale, h.a);
                // A light that flickers or a volume that moves changes the froxel fast: lean on the new.
                let lumNow = dot(current.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
                let lumThen = dot(history.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
                let ratio = (min(lumNow, lumThen) + 1e-6) / (max(lumNow, lumThen) + 1e-6);
                let w = u_fogv.u_historyWeight * mix(0.4, 1.0, ratio);
                if (all(history == history)) { current = mix(current, history, w); }
            }
        }
    }
    return current;
}

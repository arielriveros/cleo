#version 300 es

// Volumetric clouds: a single fullscreen raymarch (runs on screen.vs). For every pixel a
// world-space view ray is reconstructed from u_invViewProj, intersected with a horizontal
// cloud slab, and marched through a procedural density field (value-noise FBM shaped by a
// height gradient + coverage, eroded by higher-frequency detail). Lighting uses a secondary
// march toward the sun (Beer-Powder) with a Henyey-Greenstein phase + silver lining, plus a
// sky/ground ambient gradient. The scene depth buffer bounds the ray so solid geometry
// occludes the clouds. Output is straight-alpha (composited with SRC_ALPHA, ONE_MINUS_SRC_ALPHA).

precision highp float;
// GLSL ES 3.00 predeclares default precision for sampler2D/samplerCube in the fragment language but
// NOT for sampler3D, so this qualifier is mandatory — without it the shader fails to compile.
precision highp sampler3D;

in vec2 fragTexCoord;

layout(location = 0) out vec4 fragColor;

// Camera / scene
uniform mat4  u_invViewProj;   // reconstruct the per-pixel world ray
uniform vec3  u_viewPos;       // camera world position (ray origin)
uniform sampler2D u_gDepth;    // device depth from the G-buffer (occlusion bound)
uniform float u_time;          // seconds, for wind animation

// Shape
uniform float u_coverage;
uniform float u_density;
uniform float u_cloudType;     // 0 = stratus (flat) .. 1 = cumulonimbus (towering)
uniform float u_baseAltitude;
uniform float u_thickness;
uniform float u_baseScale;
uniform float u_detailScale;
uniform float u_detailStrength;
uniform float u_curlStrength;
uniform float u_anvilBias;

// Lighting
uniform vec3  u_sunDir;        // sun *travel* direction (like a directional light's forward)
uniform vec3  u_sunColor;
uniform float u_sunIntensity;
uniform vec3  u_ambientColor;
uniform float u_ambientIntensity;
uniform vec3  u_groundColor;
uniform float u_phaseG;
uniform float u_silverIntensity;
uniform float u_silverSpread;
uniform float u_powderStrength;
uniform float u_absorption;

// Animation
uniform vec3  u_wind;          // direction (x/z used)
uniform float u_windSpeed;
uniform float u_detailWindFactor;

// Quality
uniform int   u_steps;
uniform int   u_lightSteps;
uniform float u_maxDistance;
uniform bool  u_jitter;

// Temporal (Bayer-subset) mode — see traceUV().
uniform bool  u_temporal;
uniform vec2  u_traceResolution; // size of the reduced trace target, in pixels
uniform ivec2 u_bayerOffset;     // sub-position within the 4x4 block traced this frame
// Which slot of the 16-frame Bayer cycle this frame is, used to advance the ray-start dither. Also
// set on the non-temporal paths (from the raw frame counter) so they still get a moving dither.
uniform int   u_jitterSlot;

// Render
uniform float u_opacity;

const float PI = 3.14159265359;
const int   MAX_STEPS = 192;
const int   MAX_LIGHT_STEPS = 12;

// ---------------------------------------------------------------------------
// Noise: sampled from baked tileable 3D volumes (see cloudNoiseBake.fs)
//
// These replace the multi-octave hash FBM this shader used to evaluate inline. The old version cost
// ~32 hash+lerp taps for the base field and ~24 more for detail, PER SAMPLE — and the secondary
// sun-march re-evaluated the base field at every one of its steps too. Two trilinear fetches now
// return the same fields.
//
// The volumes tile, so the world-space field repeats every (period / scale) units. With the default
// baseScale that is ~20km for the base shape, far past any view distance; the detail volume repeats
// much sooner but is only ever an erosion modulation on top of the base, which hides it.
// ---------------------------------------------------------------------------

uniform sampler3D u_baseNoise;    // R = shape, G/B = finer bands, A = warp source
uniform sampler3D u_detailNoise;  // RGB = high-frequency erosion bands
uniform float u_baseNoiseInvPeriod;   // 1 / lattice cells across the base volume
uniform float u_detailNoiseInvPeriod; // 1 / lattice cells across the detail volume

/**
 * Interleaved gradient noise (Jimenez, "Next Generation Post Processing in Call of Duty"), the
 * spatial dither for the ray start.
 *
 * It has to be SPATIAL rather than per-frame random. The temporal resolve accumulates over a
 * 16-frame Bayer cycle, so a pixel that draws an uncorrelated offset every frame never averages —
 * the noise is simply frozen into history and reads as grain. Keyed to the pixel and stepped once
 * per Bayer slot, each pixel instead sees the same 16 offsets every cycle and converges.
 */
float ign(vec2 p) {
    return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y));
}

float remap(float v, float inMin, float inMax, float outMin, float outMax) {
    return outMin + (v - inMin) / max(inMax - inMin, 1e-5) * (outMax - outMin);
}

// Vertical density profile across the slab (h in 0..1). cloudType raises the top so stratus
// stays a flat low layer while cumulonimbus fills the slab; anvilBias flares the very top.
float heightGradient(float h, float type) {
    float topEnd = mix(0.25, 1.0, type);
    float bottom = smoothstep(0.0, 0.12, h);
    float top = 1.0 - smoothstep(topEnd * 0.6, topEnd, h);
    float anvil = 1.0 + u_anvilBias * smoothstep(0.5, 1.0, h) * 1.5;
    return clamp(bottom * top, 0.0, 1.0) * anvil;
}

vec3 g_wind;

// Cloud density at a world position. `cheap` skips the detail erosion (used for the cheap
// toward-sun light march).
float sampleDensity(vec3 pos, float h, bool cheap) {
    vec3 p = pos + g_wind;

    // Low-frequency base shape, from the baked volume.
    float base = texture(u_baseNoise, p * u_baseScale * u_baseNoiseInvPeriod).r;

    // Coverage remaps the base so higher coverage lets more of the field through; anvilBias
    // widens the effective coverage near the top for spreading cumulonimbus caps.
    float cov = clamp(u_coverage * (1.0 + h * u_anvilBias * 0.6), 0.0, 1.0);
    float shape = smoothstep(1.0 - cov, 1.0, base);

    float density = shape * heightGradient(h, u_cloudType);
    if (density <= 0.0) return 0.0;

    if (!cheap && u_detailStrength > 0.0) {
        // Curl-ish domain warp for wispy edges, then erode with high-frequency detail.
        vec3 dp = pos + g_wind * u_detailWindFactor;
        if (u_curlStrength > 0.0) {
            // Curl-ish domain warp. The warp vector comes from the base volume's spare channels
            // rather than a hash: it is smooth (so the warp is coherent rather than per-cell noise)
            // and it is a fetch we can afford next to the ones already happening here.
            vec4 warpSample = texture(u_baseNoise, pos * u_baseScale * 4.0 * u_baseNoiseInvPeriod);
            vec3 warp = warpSample.gba - 0.5;
            dp += warp * u_curlStrength * (1.0 / max(u_detailScale, 1e-5)) * 0.15
                  + vec3(warpSample.a) * u_curlStrength * 50.0;
        }
        float detail = texture(u_detailNoise, dp * u_detailScale * u_detailNoiseInvPeriod).r;
        density = remap(density, detail * u_detailStrength, 1.0, 0.0, 1.0);
    }

    return clamp(density, 0.0, 1.0) * heightGradient(h, u_cloudType) * clamp(u_density / 2.5, 0.0, 1.0);
}

float henyeyGreenstein(float cosAngle, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * cosAngle, 1.5));
}

vec3 reconstructWorldPos(float depth, vec2 uv) {
    vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 world = u_invViewProj * clip;
    return world.xyz / world.w;
}

vec3 acesFilm(vec3 x) {
    const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

/**
 * The UV this fragment should trace.
 *
 * In temporal mode this shader renders into a buffer 1/4 the size per axis, where each pixel owns one
 * 4x4 block of the full-resolution cloud image and traces ONE sub-position within it — the one
 * u_bayerIndex selects this frame. So 1/16 of the rays are cast, and cloudTemporalResolve.fs
 * reconstructs the rest from reprojected history.
 *
 * Doing the selection here, by remapping the UV, rather than by rendering full-size and discarding,
 * means the saved rays are genuinely never rasterized.
 */
vec2 traceUV() {
    if (!u_temporal) return fragTexCoord;
    // Block index this fragment stands for, from its position in the reduced-size target.
    vec2 block = floor(fragTexCoord * u_traceResolution);
    vec2 sub = vec2(u_bayerOffset);
    // Centre of the chosen sub-pixel, in full cloud-resolution UV space.
    return (block * 4.0 + sub + 0.5) / (u_traceResolution * 4.0);
}

void main() {
    vec2 uv = traceUV();

    // 1. World-space view ray (near -> far), origin at the camera.
    vec2 ndc = uv * 2.0 - 1.0;
    vec4 nW = u_invViewProj * vec4(ndc, -1.0, 1.0);
    vec4 fW = u_invViewProj * vec4(ndc,  1.0, 1.0);
    vec3 ro = nW.xyz / nW.w;
    vec3 rd = normalize(fW.xyz / fW.w - ro);

    // 2. Occlusion bound: distance to solid geometry (background depth == 1.0 => infinite).
    float depth = texture(u_gDepth, uv).r;
    float sceneDist = u_maxDistance;
    if (depth < 1.0) sceneDist = min(sceneDist, length(reconstructWorldPos(depth, uv) - u_viewPos));

    // 3. Intersect the horizontal cloud slab.
    float slabBottom = u_baseAltitude;
    float slabTop = u_baseAltitude + u_thickness;
    float tEnter, tExit;
    if (abs(rd.y) < 1e-5) {
        // Ray (near) parallel to the slab: only lit if the camera sits inside it.
        if (u_viewPos.y < slabBottom || u_viewPos.y > slabTop) { fragColor = vec4(0.0); return; }
        tEnter = 0.0;
        tExit = sceneDist;
    } else {
        float t0 = (slabBottom - u_viewPos.y) / rd.y;
        float t1 = (slabTop - u_viewPos.y) / rd.y;
        tEnter = min(t0, t1);
        tExit = max(t0, t1);
    }
    tEnter = max(tEnter, 0.0);
    tExit = min(tExit, sceneDist);
    if (tEnter >= tExit) { fragColor = vec4(0.0); return; }

    g_wind = u_wind * (u_windSpeed * u_time);

    int steps = clamp(u_steps, 1, MAX_STEPS);
    float marchLen = tExit - tEnter;
    float stepLen = marchLen / float(steps);

    // Dither the start to trade banding for noise, advanced by the golden ratio each Bayer slot so
    // the 16 offsets a pixel sees over a cycle are well spread.
    //
    // The dither MUST be keyed to the full-resolution pixel this ray reconstructs, not to
    // gl_FragCoord: in temporal mode gl_FragCoord is the trace buffer's coordinate, so a given
    // full-res pixel drew an unrelated offset every time its block came up.
    vec2 jitterPx = u_temporal ? floor(uv * u_traceResolution * 4.0) : gl_FragCoord.xy;
    float jitter = u_jitter ? fract(ign(jitterPx) + float(u_jitterSlot) * 0.6180339887) : 0.0;
    float t = tEnter + stepLen * jitter;

    // Sun setup (direction *toward* the sun) + phase.
    vec3 sunDir = normalize(-u_sunDir);
    float cosAngle = dot(rd, sunDir);
    float phase = max(henyeyGreenstein(cosAngle, u_phaseG),
                      u_silverIntensity * henyeyGreenstein(cosAngle, clamp(0.99 - u_silverSpread, 0.0, 0.999)));
    vec3 sunLight = u_sunColor * u_sunIntensity;

    int lightSteps = clamp(u_lightSteps, 1, MAX_LIGHT_STEPS);
    float lightStepLen = u_thickness / float(lightSteps);
    float invSlab = 1.0 / max(u_thickness, 1e-3);

    float transmittance = 1.0;
    vec3 scatteredLight = vec3(0.0);

    // ---------------------------------------------------------------------------------------
    // Two-speed march.
    //
    // Clouds are mostly empty sky: for a typical coverage the great majority of samples along a ray
    // return zero density, and the expensive work (detail-erosion FBM, plus a whole secondary march
    // toward the sun) only happens where density > 0. Marching at the fine step everywhere therefore
    // spends most of its samples proving that nothing is there.
    //
    // So: step at CHEAP_STEP_SCALE x the fine step using the cheap density (no detail erosion) until
    // something is hit, then back up one coarse step and switch to fine stepping with the full
    // density. After MISSES_BEFORE_COARSE consecutive empty fine samples, drop back to coarse.
    //
    // The step budget below counts coarse and fine samples against the same `steps` allowance, so the
    // worst case (a ray entirely inside dense cloud) costs exactly what it did before, while the
    // common case gets much cheaper. Backing up before the fine march is what keeps the cloud
    // boundary in the same place — without it, silhouettes would visibly snap to the coarse stride.
    // ---------------------------------------------------------------------------------------
    const float CHEAP_STEP_SCALE = 3.0;
    const int MISSES_BEFORE_COARSE = 8;

    bool coarse = true;
    int misses = 0;

    for (int i = 0; i < MAX_STEPS; i++) {
        if (i >= steps || transmittance < 0.01 || t > tExit) break;
        vec3 pos = u_viewPos + rd * t;
        float h = clamp((pos.y - slabBottom) * invSlab, 0.0, 1.0);

        if (coarse) {
            // Cheap probe: base shape only. A hit rewinds one coarse step so the fine march starts
            // just OUTSIDE the cloud and the edge lands where a fine-only march would have put it.
            if (sampleDensity(pos, h, true) > 0.0) {
                coarse = false;
                misses = 0;
                t = max(tEnter, t - stepLen * CHEAP_STEP_SCALE);
                continue;
            }
            t += stepLen * CHEAP_STEP_SCALE;
            continue;
        }

        float density = sampleDensity(pos, h, false);

        if (density > 0.001) {
            misses = 0;
            // Secondary march toward the sun for self-shadowing (cheap density).
            float lightOpticalDepth = 0.0;
            for (int j = 0; j < MAX_LIGHT_STEPS; j++) {
                if (j >= lightSteps) break;
                vec3 lp = pos + sunDir * (lightStepLen * (float(j) + 0.5));
                float lh = clamp((lp.y - slabBottom) * invSlab, 0.0, 1.0);
                lightOpticalDepth += sampleDensity(lp, lh, true) * lightStepLen;
            }

            float beers = exp(-lightOpticalDepth * u_absorption);
            float powder = 1.0 - exp(-lightOpticalDepth * 2.0 * u_absorption);
            float powderTerm = mix(1.0, 2.0 * powder, u_powderStrength);

            vec3 sampleLight = sunLight * beers * powderTerm * phase;
            vec3 ambient = mix(u_groundColor, u_ambientColor, h) * u_ambientIntensity;

            // Energy-conserving analytical integration of in-scattering over the step.
            float sigmaT = density * u_absorption;
            vec3 S = (sampleLight + ambient) * density;
            float tr = exp(-sigmaT * stepLen);
            vec3 Sint = (S - S * tr) / max(sigmaT, 1e-5);
            scatteredLight += transmittance * Sint;
            transmittance *= tr;
        } else {
            misses++;
            if (misses >= MISSES_BEFORE_COARSE) { coarse = true; misses = 0; }
        }

        t += stepLen;
    }

    float alpha = (1.0 - transmittance) * u_opacity;
    if (alpha <= 0.0) { fragColor = vec4(0.0); return; }

    // The scene buffer is LINEAR HDR now — output linear scattered radiance and let the single final
    // tonemapper handle exposure/tonemap/gamma like every other surface. Output is PREMULTIPLIED
    // (composited with ONE, ONE_MINUS_SRC_ALPHA) so bilinear upsampling from the reduced-resolution
    // path doesn't fringe cloud silhouettes toward black.
    fragColor = vec4(scatteredLight * alpha, alpha);
}

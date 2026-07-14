#version 300 es

// Volumetric clouds: a single fullscreen raymarch (runs on screen.vs). For every pixel a
// world-space view ray is reconstructed from u_invViewProj, intersected with a horizontal
// cloud slab, and marched through a procedural density field (value-noise FBM shaped by a
// height gradient + coverage, eroded by higher-frequency detail). Lighting uses a secondary
// march toward the sun (Beer-Powder) with a Henyey-Greenstein phase + silver lining, plus a
// sky/ground ambient gradient. The scene depth buffer bounds the ray so solid geometry
// occludes the clouds. Output is straight-alpha (composited with SRC_ALPHA, ONE_MINUS_SRC_ALPHA).

precision highp float;

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

// Render
uniform float u_opacity;

const float PI = 3.14159265359;
const int   MAX_STEPS = 192;
const int   MAX_LIGHT_STEPS = 12;

// ---------------------------------------------------------------------------
// Hash-based value noise (self-contained, no textures)
// ---------------------------------------------------------------------------
float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
}

vec3 hash33(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx);
}

float valueNoise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash13(i + vec3(0.0, 0.0, 0.0));
    float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
    float nx00 = mix(n000, n100, f.x);
    float nx10 = mix(n010, n110, f.x);
    float nx01 = mix(n001, n101, f.x);
    float nx11 = mix(n011, n111, f.x);
    float nxy0 = mix(nx00, nx10, f.y);
    float nxy1 = mix(nx01, nx11, f.y);
    return mix(nxy0, nxy1, f.z);
}

float fbm(vec3 p) {
    float sum = 0.0;
    float amp = 0.5;
    float norm = 0.0;
    for (int i = 0; i < 4; i++) {
        sum += amp * valueNoise(p);
        norm += amp;
        p *= 2.02;
        amp *= 0.5;
    }
    return sum / norm;
}

float fbm3(vec3 p) {
    float sum = 0.0;
    float amp = 0.5;
    float norm = 0.0;
    for (int i = 0; i < 3; i++) {
        sum += amp * valueNoise(p);
        norm += amp;
        p *= 2.03;
        amp *= 0.5;
    }
    return sum / norm;
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

    // Low-frequency base shape.
    float base = fbm(p * u_baseScale);

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
            vec3 warp = hash33(floor(pos * u_baseScale * 4.0)) - 0.5;
            dp += warp * u_curlStrength * (1.0 / max(u_detailScale, 1e-5)) * 0.15
                  + vec3(fbm3(pos * u_detailScale * 0.5)) * u_curlStrength * 50.0;
        }
        float detail = fbm3(dp * u_detailScale);
        density = remap(density, detail * u_detailStrength, 1.0, 0.0, 1.0);
    }

    return clamp(density, 0.0, 1.0) * heightGradient(h, u_cloudType) * clamp(u_density / 2.5, 0.0, 1.0);
}

float henyeyGreenstein(float cosAngle, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * cosAngle, 1.5));
}

vec3 reconstructWorldPos(float depth) {
    vec4 clip = vec4(fragTexCoord * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 world = u_invViewProj * clip;
    return world.xyz / world.w;
}

vec3 acesFilm(vec3 x) {
    const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
    // 1. World-space view ray (near -> far), origin at the camera.
    vec2 ndc = fragTexCoord * 2.0 - 1.0;
    vec4 nW = u_invViewProj * vec4(ndc, -1.0, 1.0);
    vec4 fW = u_invViewProj * vec4(ndc,  1.0, 1.0);
    vec3 ro = nW.xyz / nW.w;
    vec3 rd = normalize(fW.xyz / fW.w - ro);

    // 2. Occlusion bound: distance to solid geometry (background depth == 1.0 => infinite).
    float depth = texture(u_gDepth, fragTexCoord).r;
    float sceneDist = u_maxDistance;
    if (depth < 1.0) sceneDist = min(sceneDist, length(reconstructWorldPos(depth) - u_viewPos));

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

    // Dither the start to trade banding for noise.
    float jitter = u_jitter ? hash13(vec3(gl_FragCoord.xy, u_time)) : 0.0;
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

    for (int i = 0; i < MAX_STEPS; i++) {
        if (i >= steps || transmittance < 0.01) break;
        vec3 pos = u_viewPos + rd * t;
        float h = clamp((pos.y - slabBottom) * invSlab, 0.0, 1.0);
        float density = sampleDensity(pos, h, false);

        if (density > 0.001) {
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
        }

        t += stepLen;
    }

    float alpha = (1.0 - transmittance) * u_opacity;
    if (alpha <= 0.0) { fragColor = vec4(0.0); return; }

    // The scene buffer is LINEAR HDR now — output linear scattered radiance and let the single final
    // tonemapper handle exposure/tonemap/gamma like every other surface.
    fragColor = vec4(scatteredLight, alpha);
}

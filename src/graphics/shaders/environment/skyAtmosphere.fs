#version 300 es

// Physically-based sky (Nishita / O'Neil single scattering). Rendered once per cube face when the
// sun moves: cube.vs hands us the world-space sample direction as `localPos`. For each direction we
// raymarch a view ray through a spherical atmosphere, and at every sample raymarch toward the sun to
// get the light optical depth (Beer extinction). Rayleigh (wavelength-dependent) gives the blue day
// sky + red sunsets; Mie gives the bright haze/aureole around the sun. Output is tonemapped +
// gamma-encoded (display-referred) so the existing 'skybox' shader can sample it unchanged.
//
// highp is required: radii are ~6.4e6 m and scattering coefficients ~1e-5 /m.

precision highp float;

in vec3 localPos;

layout(location = 0) out vec4 fragColor;

uniform vec3  u_sunDir;          // direction TOWARD the sun (normalized)
uniform vec3  u_sunColor;
uniform float u_sunIntensity;
uniform vec3  u_rayleigh;        // Rayleigh scattering coefficients (per meter)
uniform float u_mie;             // Mie scattering coefficient (per meter)
uniform float u_rayleighHeight;  // Rayleigh scale height (m)
uniform float u_mieHeight;       // Mie scale height (m)
uniform float u_mieG;            // Mie anisotropy
uniform float u_planetRadius;    // m
uniform float u_atmosphereRadius;// m
uniform float u_sunDiskSize;     // angular radius of the sun disk (degrees)
uniform float u_exposure;
uniform vec3  u_groundColor;
uniform int   u_viewSteps;
uniform int   u_lightSteps;

const float PI = 3.14159265359;
const int   MAX_VIEW_STEPS = 64;
const int   MAX_LIGHT_STEPS = 32;

// Intersect a ray with a sphere centered at the origin. Returns (nearT, farT); nearT > farT on miss.
vec2 raySphere(vec3 ro, vec3 rd, float r) {
    float b = dot(ro, rd);
    float c = dot(ro, ro) - r * r;
    float d = b * b - c;
    if (d < 0.0) return vec2(1e9, -1e9);
    d = sqrt(d);
    return vec2(-b - d, -b + d);
}

vec3 atmosphere(vec3 rd, vec3 ro, vec3 sunDir) {
    vec2 atmHit = raySphere(ro, rd, u_atmosphereRadius);
    if (atmHit.x > atmHit.y) return vec3(0.0);
    float tStart = max(atmHit.x, 0.0);
    float tEnd = atmHit.y;
    // Stop the view ray at the planet surface if it hits it.
    vec2 planetHit = raySphere(ro, rd, u_planetRadius);
    if (planetHit.x > 0.0) tEnd = min(tEnd, planetHit.x);

    int viewSteps = u_viewSteps;
    float stepSize = (tEnd - tStart) / float(viewSteps);

    vec3 betaR = u_rayleigh;
    float betaM = u_mie;

    // Phase functions.
    float mu = dot(rd, sunDir);
    float mu2 = mu * mu;
    float phaseR = 3.0 / (16.0 * PI) * (1.0 + mu2);
    float g = u_mieG;
    float g2 = g * g;
    float phaseM = 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + mu2)) /
                   ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * mu, 0.0), 1.5));

    vec3 sumR = vec3(0.0);
    vec3 sumM = vec3(0.0);
    float odR = 0.0; // view-ray optical depth (Rayleigh)
    float odM = 0.0; // view-ray optical depth (Mie)

    float t = tStart;
    for (int i = 0; i < MAX_VIEW_STEPS; i++) {
        if (i >= viewSteps) break;
        vec3 pos = ro + rd * (t + stepSize * 0.5);
        float height = length(pos) - u_planetRadius;
        float hr = exp(-height / u_rayleighHeight) * stepSize;
        float hm = exp(-height / u_mieHeight) * stepSize;
        odR += hr;
        odM += hm;

        // Secondary ray toward the sun.
        vec2 lightHit = raySphere(pos, sunDir, u_atmosphereRadius);
        float lightStep = lightHit.y / float(u_lightSteps);
        float odLR = 0.0;
        float odLM = 0.0;
        float tl = 0.0;
        bool inShadow = false;
        for (int j = 0; j < MAX_LIGHT_STEPS; j++) {
            if (j >= u_lightSteps) break;
            vec3 lpos = pos + sunDir * (tl + lightStep * 0.5);
            float lheight = length(lpos) - u_planetRadius;
            if (lheight < 0.0) { inShadow = true; break; } // occluded by the planet
            odLR += exp(-lheight / u_rayleighHeight) * lightStep;
            odLM += exp(-lheight / u_mieHeight) * lightStep;
            tl += lightStep;
        }

        if (!inShadow) {
            // Transmittance = extinction along view path so far + light path (Mie has slight absorption).
            vec3 tau = betaR * (odR + odLR) + betaM * 1.1 * (odM + odLM);
            vec3 attenuation = exp(-tau);
            sumR += attenuation * hr;
            sumM += attenuation * hm;
        }
        t += stepSize;
    }

    return u_sunIntensity * (sumR * betaR * phaseR + sumM * betaM * phaseM);
}

vec3 acesFilm(vec3 x) {
    const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
    vec3 dir = normalize(localPos);
    vec3 sunDir = normalize(u_sunDir);
    // View from just above the planet surface (up is +Y). The sky is direction-only, so camera
    // translation is irrelevant — this matches the skybox draw (view translation is stripped).
    vec3 ro = vec3(0.0, u_planetRadius + 1.0, 0.0);

    vec3 col = atmosphere(dir, ro, sunDir) * u_sunColor;

    // Sun disk: only when looking toward the sun, the sun is above the horizon, and the view ray
    // isn't looking into the ground. Attenuated by Mie forward-scatter already tints it at sunset.
    vec2 viewPlanet = raySphere(ro, dir, u_planetRadius);
    bool viewHitsGround = viewPlanet.x > 0.0;
    float sunCos = dot(dir, sunDir);
    float diskCos = cos(radians(max(u_sunDiskSize, 0.001)));
    if (!viewHitsGround && sunDir.y > -0.02 && sunCos > diskCos) {
        float disk = smoothstep(diskCos, mix(diskCos, 1.0, 0.35), sunCos);
        col += u_sunColor * u_sunIntensity * 0.35 * disk;
    }

    // Lower hemisphere: rays into the planet come back near-black; blend a lit ground tint so the
    // bottom of the cubemap reads as ground rather than a black void.
    if (viewHitsGround) {
        float lambert = max(sunDir.y, 0.0) * 0.9 + 0.1;
        vec3 ground = u_groundColor * lambert * u_sunColor * (u_sunIntensity * 0.05);
        float blend = smoothstep(0.0, -0.15, dir.y);
        col = mix(col, ground, blend);
    }

    // Exposure + tonemap + sRGB so the baked cubemap is display-referred.
    col = acesFilm(col * u_exposure);
    col = pow(col, vec3(1.0 / 2.2));
    fragColor = vec4(col, 1.0);
}

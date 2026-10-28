// Physically-based sky (Nishita / O'Neil single scattering).
//
// Rendered once per cube face when the sun moves: the cube vertex stage hands each fragment its
// world-space sample direction. For every direction we raymarch a view ray through a spherical
// atmosphere, and at each sample raymarch toward the sun for the light optical depth (Beer
// extinction). Rayleigh (wavelength-dependent) gives the blue day sky and red sunsets; Mie gives the
// bright haze and aureole around the sun.
//
// After sunset the same bake adds the night sky: the atmosphere scattered a second time with the MOON
// as its light (the faint blue moonlit sky and the halo round the moon), procedural stars or a custom
// equirect night-sky texture, airglow near the horizon so a moonless night is not black, and the moon
// disc itself, shaded by its phase. All of it scales with `u_night`, which the renderer derives from the
// sun's elevation, so a day bake pays for none of it.
//
// f32 precision is not optional here: radii are ~6.4e6 m and scattering coefficients ~1e-5 per metre,
// which is why the GLSL twin declared `precision highp float` explicitly. WGSL has no lowp/mediump, so
// the requirement is satisfied by construction.

#include "./chunks/cubeVertex.wgsl"

const PI: f32 = 3.14159265359;
const MAX_VIEW_STEPS: i32 = 64;
const MAX_LIGHT_STEPS: i32 = 32;

struct SkyUniforms {
    u_sunDir: vec3<f32>,          // direction TOWARD the sun (normalised)
    u_sunColor: vec3<f32>,
    u_rayleigh: vec3<f32>,        // Rayleigh scattering coefficients (per metre)
    u_groundColor: vec3<f32>,
    u_sunIntensity: f32,
    u_mie: f32,                   // Mie scattering coefficient (per metre)
    u_rayleighHeight: f32,        // Rayleigh scale height (m)
    u_mieHeight: f32,             // Mie scale height (m)
    u_mieG: f32,                  // Mie anisotropy
    u_planetRadius: f32,          // m
    u_atmosphereRadius: f32,      // m
    u_sunDiskSize: f32,           // angular radius of the sun disk (degrees)
    u_exposure: f32,
    u_viewSteps: i32,
    u_lightSteps: i32,
    // Night sky (see the header). Directions are unit vectors TOWARD the body.
    u_moonDir: vec3<f32>,
    u_moonColor: vec3<f32>,
    u_airglowColor: vec3<f32>,
    u_night: f32,                 // 0 = day .. 1 = full night
    u_starIntensity: f32,
    u_starDensity: f32,
    u_starColorVariance: f32,
    u_nightSkyIntensity: f32,
    u_nightSkyRotation: f32,      // radians about +Y
    u_moonSize: f32,              // angular radius, radians
    u_moonPhase: f32,             // 0 = new .. 1 = full
    u_moonIntensity: f32,
    u_airglowIntensity: f32,
    u_nightTexture: i32,          // 1 = sample the custom night-sky texture instead of procedural stars
    u_moonTexture: i32,           // 1 = sample the custom moon texture instead of the procedural disc
    u_moonEnabled: i32,
    /**
     * The whole night sky's brightness: `moonlightIntensity / 0.08`, so 1 at the default. The moonlit air
     * is the sunlit air times the moon-to-sun illuminance ratio, which is exactly what moonlightIntensity
     * is for the moon's key light; the stars, airglow and disc ride along so the night keeps its balance.
     * A scene with a real moon (lux in the single digits against a 100,000 lx sun) gets a sky that dark
     * too, and its auto exposure opens up to it instead of the sky lighting the ground at 6% of day.
     */
    u_nightScale: f32,
};
@group(0) @binding(0) var<uniform> u_sky: SkyUniforms;
// Group 1 is the cube transform (cubeVertex.wgsl). Both textures are bound always — a 1x1 fallback when
// unset — and the flags above say whether to read them.
@group(2) @binding(0) var u_nightSky_texture: texture_2d<f32>;
@group(2) @binding(1) var u_nightSky_sampler: sampler;
@group(2) @binding(2) var u_moonTex_texture: texture_2d<f32>;
@group(2) @binding(3) var u_moonTex_sampler: sampler;

/** Moonlit sky relative to the sunlit one, per unit of `moonIntensity` and phase. Artistic, not the real ~1e-6. */
const MOON_SKY: f32 = 0.06;
/** Moon disc radiance relative to the sun disc's, per unit of `moonIntensity`. */
const MOON_DISC: f32 = 0.08;

/** Ray against a sphere at the origin. Returns (nearT, farT); nearT > farT means a miss. */
fn raySphere(ro: vec3<f32>, rd: vec3<f32>, r: f32) -> vec2<f32> {
    let b = dot(ro, rd);
    let c = dot(ro, ro) - r * r;
    var d = b * b - c;
    if (d < 0.0) { return vec2<f32>(1e9, -1e9); }
    d = sqrt(d);
    return vec2<f32>(-b - d, -b + d);
}

/** Transmittance of the atmosphere from `ro` along `rd` (toward a light). Zero through the planet. */
fn transmittanceTo(ro: vec3<f32>, rd: vec3<f32>) -> vec3<f32> {
    let hit = raySphere(ro, rd, u_sky.u_atmosphereRadius);
    let steps = u_sky.u_lightSteps;
    let stepLen = max(hit.y, 0.0) / f32(steps);
    var odR = 0.0;
    var odM = 0.0;
    for (var j = 0; j < MAX_LIGHT_STEPS; j++) {
        if (j >= steps) { break; }
        let p = ro + rd * (stepLen * (f32(j) + 0.5));
        let h = length(p) - u_sky.u_planetRadius;
        if (h < 0.0) { return vec3<f32>(0.0); }
        odR += exp(-h / u_sky.u_rayleighHeight) * stepLen;
        odM += exp(-h / u_sky.u_mieHeight) * stepLen;
    }
    return exp(-(u_sky.u_rayleigh * odR + u_sky.u_mie * 1.1 * odM));
}

fn hash13(p: vec3<f32>) -> f32 {
    var q = fract(p * 0.1031);
    q += vec3<f32>(dot(q, q.zyx + 31.32));
    return fract((q.x + q.y) * q.z);
}

fn hash33(p: vec3<f32>) -> vec3<f32> {
    var q = fract(p * vec3<f32>(0.1031, 0.1030, 0.0973));
    q += vec3<f32>(dot(q, q.yxz + 33.33));
    return fract((q.xxy + q.yxx) * q.zyx);
}

/**
 * One layer of procedural stars: a 3D grid on the direction, at most one star per cell, at a random
 * point inside it. Brightness follows a steep power law (a few bright stars, many faint ones) and the
 * colour a random temperature between blue-white and orange.
 */
fn starLayer(dir: vec3<f32>, scale: f32, density: f32) -> vec3<f32> {
    let q = dir * scale;
    let cell = floor(q);
    let h = hash13(cell);
    if (h > density) { return vec3<f32>(0.0); }
    let star = cell + hash33(cell + 17.0);
    let d = length(q - star);
    let r = h / max(density, 1e-4);              // 0..1 within the cells that hold a star
    let brightness = pow(1.0 - r, 6.0) * 4.0 + 0.15;
    let core = exp(-d * d * 28.0);
    let t = hash13(cell + 5.0);
    let warm = vec3<f32>(1.0, 0.72, 0.45);
    let cool = vec3<f32>(0.62, 0.75, 1.0);
    let tint = mix(vec3<f32>(1.0), mix(cool, warm, t), u_sky.u_starColorVariance);
    return tint * (brightness * core);
}

/** The custom equirect night sky, spun about +Y by `u_nightSkyRotation`. */
fn sampleNightSky(dir: vec3<f32>) -> vec3<f32> {
    let c = cos(u_sky.u_nightSkyRotation);
    let s = sin(u_sky.u_nightSkyRotation);
    let d = vec3<f32>(c * dir.x - s * dir.z, dir.y, s * dir.x + c * dir.z);
    let uv = vec2<f32>(0.5 + atan2(d.x, -d.z) / (2.0 * PI), 0.5 - asin(clamp(d.y, -1.0, 1.0)) / PI);
    return textureSampleLevel(u_nightSky_texture, u_nightSky_sampler, uv, 0.0).rgb;
}

fn valueNoise2(p: vec2<f32>) -> f32 {
    let i = floor(p);
    var f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    let a = hash13(vec3<f32>(i, 3.0));
    let b = hash13(vec3<f32>(i + vec2<f32>(1.0, 0.0), 3.0));
    let c = hash13(vec3<f32>(i + vec2<f32>(0.0, 1.0), 3.0));
    let d = hash13(vec3<f32>(i + vec2<f32>(1.0, 1.0), 3.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

/**
 * The moon disc in direction `dir`: rgb is its shaded radiance, a its coverage (0 outside the disc).
 * The disc is a sphere lit from the side facing the sun, with the phase setting how far round that
 * light has swung: full when it is behind the viewer, new when it is behind the moon. A sliver of
 * earthshine keeps the dark side just visible.
 *
 * Coverage is returned separately because the moon is OPAQUE: the stars and a custom night sky sit
 * behind it, unlit side included, and must be hidden by the whole disc, not just by its lit part.
 */
fn moonDisc(dir: vec3<f32>, sunDir: vec3<f32>) -> vec4<f32> {
    let m = normalize(u_sky.u_moonDir);
    let cosR = cos(u_sky.u_moonSize);
    let cosA = dot(dir, m);
    if (cosA < cosR) { return vec4<f32>(0.0); }
    // Disc frame: `right` points at the sun's side of the moon.
    var toward = sunDir - m * dot(sunDir, m);
    if (dot(toward, toward) < 1e-6) { toward = cross(m, vec3<f32>(0.0, 1.0, 0.0)); }
    let right = normalize(toward);
    let up = cross(right, m);
    let sinR = sin(u_sky.u_moonSize);
    let p = vec2<f32>(dot(dir, right), dot(dir, up)) / sinR;
    let r2 = dot(p, p);
    if (r2 > 1.0) { return vec4<f32>(0.0); }
    let n = vec3<f32>(p.x, p.y, sqrt(1.0 - r2));
    let theta = PI * (1.0 - u_sky.u_moonPhase);
    let lit = max(dot(n, vec3<f32>(sin(theta), 0.0, cos(theta))), 0.0);
    var albedo: vec3<f32>;
    if (u_sky.u_moonTexture != 0) {
        albedo = textureSampleLevel(u_moonTex_texture, u_moonTex_sampler, p * vec2<f32>(0.5, -0.5) + 0.5, 0.0).rgb;
    } else {
        let maria = valueNoise2(p * 2.2 + 4.0) * 0.6 + valueNoise2(p * 5.5 + 9.0) * 0.4;
        albedo = vec3<f32>(0.78 - 0.32 * smoothstep(0.45, 0.75, maria));
    }
    // Soft limb so the disc edge anti-aliases in the cubemap.
    let edge = 1.0 - smoothstep(0.92, 1.0, sqrt(r2));
    return vec4<f32>(albedo * (lit + 0.015) * edge, edge);
}

fn atmosphere(rd: vec3<f32>, ro: vec3<f32>, sunDir: vec3<f32>) -> vec3<f32> {
    let atmHit = raySphere(ro, rd, u_sky.u_atmosphereRadius);
    if (atmHit.x > atmHit.y) { return vec3<f32>(0.0); }
    let tStart = max(atmHit.x, 0.0);
    var tEnd = atmHit.y;
    // Stop the view ray at the planet surface if it hits it.
    let planetHit = raySphere(ro, rd, u_sky.u_planetRadius);
    if (planetHit.x > 0.0) { tEnd = min(tEnd, planetHit.x); }

    let viewSteps = u_sky.u_viewSteps;
    let stepSize = (tEnd - tStart) / f32(viewSteps);

    let betaR = u_sky.u_rayleigh;
    let betaM = u_sky.u_mie;

    // Phase functions.
    let mu = dot(rd, sunDir);
    let mu2 = mu * mu;
    let phaseR = 3.0 / (16.0 * PI) * (1.0 + mu2);
    let g = u_sky.u_mieG;
    let g2 = g * g;
    let phaseM = 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + mu2))
                 / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * mu, 0.0), 1.5));

    var sumR = vec3<f32>(0.0);
    var sumM = vec3<f32>(0.0);
    var odR = 0.0;   // view-ray optical depth (Rayleigh)
    var odM = 0.0;   // view-ray optical depth (Mie)

    var t = tStart;
    for (var i = 0; i < MAX_VIEW_STEPS; i++) {
        if (i >= viewSteps) { break; }
        let pos = ro + rd * (t + stepSize * 0.5);
        let height = length(pos) - u_sky.u_planetRadius;
        let hr = exp(-height / u_sky.u_rayleighHeight) * stepSize;
        let hm = exp(-height / u_sky.u_mieHeight) * stepSize;
        odR += hr;
        odM += hm;

        // Secondary ray toward the sun.
        let lightHit = raySphere(pos, sunDir, u_sky.u_atmosphereRadius);
        let lightStep = lightHit.y / f32(u_sky.u_lightSteps);
        var odLR = 0.0;
        var odLM = 0.0;
        var tl = 0.0;
        var inShadow = false;
        for (var j = 0; j < MAX_LIGHT_STEPS; j++) {
            if (j >= u_sky.u_lightSteps) { break; }
            let lpos = pos + sunDir * (tl + lightStep * 0.5);
            let lheight = length(lpos) - u_sky.u_planetRadius;
            if (lheight < 0.0) { inShadow = true; break; }   // occluded by the planet
            odLR += exp(-lheight / u_sky.u_rayleighHeight) * lightStep;
            odLM += exp(-lheight / u_sky.u_mieHeight) * lightStep;
            tl += lightStep;
        }

        if (!inShadow) {
            // Transmittance: extinction along the view path so far plus the light path. The 1.1 on Mie
            // stands in for its slight absorption.
            let tau = betaR * (odR + odLR) + betaM * 1.1 * (odM + odLM);
            let attenuation = exp(-tau);
            sumR += attenuation * hr;
            sumM += attenuation * hm;
        }
        t += stepSize;
    }

    return u_sky.u_sunIntensity * (sumR * betaR * phaseR + sumM * betaM * phaseM);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let dir = normalize(in.localPos);
    let sunDir = normalize(u_sky.u_sunDir);
    // Viewed from just above the planet surface (up is +Y). The sky is direction-only, so camera
    // translation is irrelevant — matching the skybox draw, which strips the view translation.
    let ro = vec3<f32>(0.0, u_sky.u_planetRadius + 1.0, 0.0);

    // Which side of the horizon this ray is on, BEFORE the march: the march direction depends on it.
    let viewPlanet = raySphere(ro, dir, u_sky.u_planetRadius);
    let viewHitsGround = viewPlanet.x > 0.0;

    // A ray into the planet is occluded, so marching it returns near-black. That is physically right
    // and it reads as a black wall wherever a scene's terrain does not reach the true horizon — the
    // ground blend below then ramps FROM that black rather than from sky, which is the dark band that
    // used to sit between a landscape's silhouette and the sky. March the horizon ray instead, so the
    // lower hemisphere goes sky -> ground with nothing dark in between. Still one march per texel.
    // Straight down has no horizontal component, and both `normalize` of a zero vector and a march
    // along one produce NaN — which `mix` below then carries through the fully-ground end of the
    // blend. The nadir texel is fully ground anyway, so any horizon direction does for it.
    let flat = vec3<f32>(dir.x, 0.0, dir.z);
    let flatLen = length(flat);
    let horizonDir = select(vec3<f32>(1.0, 0.0, 0.0), flat / flatLen, flatLen > 1e-5);
    let marchDir = select(dir, horizonDir, viewHitsGround);
    var col = atmosphere(marchDir, ro, sunDir) * u_sky.u_sunColor;

    // Sun disk: only when looking toward the sun, the sun is above the horizon, and the view ray is
    // not looking into the ground. Mie forward-scatter has already tinted it by sunset.
    let sunCos = dot(dir, sunDir);
    let diskCos = cos(radians(max(u_sky.u_sunDiskSize, 0.001)));
    if (!viewHitsGround && sunDir.y > -0.02 && sunCos > diskCos) {
        let disk = smoothstep(diskCos, mix(diskCos, 1.0, 0.35), sunCos);
        col += u_sky.u_sunColor * u_sky.u_sunIntensity * 0.35 * disk;
    }

    // Night: everything the sun no longer drowns out. `u_night` is 0 in daylight, so none of this runs.
    let moonDir = normalize(u_sky.u_moonDir);
    let moonScale = u_sky.u_moonIntensity * u_sky.u_moonPhase * f32(u_sky.u_moonEnabled);
    if (u_sky.u_night > 0.0) {
        let night = u_sky.u_night * u_sky.u_nightScale;
        // The atmosphere a second time, lit by the moon: the moonlit sky and the halo round the moon.
        if (moonScale > 0.0 && moonDir.y > -0.1) {
            col += atmosphere(marchDir, ro, moonDir) * u_sky.u_moonColor * (MOON_SKY * moonScale * night);
        }
        if (!viewHitsGround) {
            let up = max(dir.y, 0.0);
            let horizon = smoothstep(-0.02, 0.12, dir.y);
            // Stars and a custom sky dim toward the horizon through the same air the sun light crosses.
            let trans = transmittanceTo(ro, dir);
            var stars: vec3<f32>;
            if (u_sky.u_nightTexture != 0) {
                stars = sampleNightSky(dir) * u_sky.u_nightSkyIntensity;
            } else {
                let density = u_sky.u_starDensity;
                stars = (starLayer(dir, 160.0, density * 0.05) + starLayer(dir, 380.0, density * 0.12) * 0.35)
                        * (u_sky.u_starIntensity * 0.12);
            }
            // The moon is in front of the stars: its whole disc hides them, even a new moon's dark one.
            var moon = vec4<f32>(0.0);
            if (u_sky.u_moonEnabled != 0) { moon = moonDisc(dir, sunDir); }
            col += stars * trans * (horizon * night * (1.0 - moon.a));
            // Airglow: a faint emission brightest toward the horizon (in the air, so in front of the moon).
            col += u_sky.u_airglowColor * (u_sky.u_airglowIntensity * 0.15 * night * (0.35 + 0.65 * pow(1.0 - up, 4.0)));
            // The moon disc, reddened near the horizon like the sun.
            if (moonScale > 0.0) {
                col += moon.rgb * transmittanceTo(ro, moonDir) * u_sky.u_moonColor
                       * (u_sky.u_sunIntensity * 0.35 * MOON_DISC * u_sky.u_moonIntensity * night);
            }
        }
    }

    // Lower hemisphere: fade the horizon sky (see `marchDir`) into a lit ground tint, so the bottom of
    // the cubemap reads as ground rather than a void. At night the moon lights it instead.
    if (viewHitsGround) {
        // The 0.1 floor is the sky's own light on the ground, which leaves with the sun: without the
        // `1 - u_night` a midnight ground glowed at a tenth of noon's, and that tint is what the sky
        // light projects into the night's ambient.
        let lambert = (max(sunDir.y, 0.0) * 0.9 + 0.1) * (1.0 - u_sky.u_night);
        var ground = u_sky.u_groundColor * lambert * u_sky.u_sunColor * (u_sky.u_sunIntensity * 0.05);
        let moonLambert = max(moonDir.y, 0.0) * 0.9 + 0.1;
        ground += u_sky.u_groundColor * moonLambert * u_sky.u_moonColor
                  * (u_sky.u_sunIntensity * 0.05 * MOON_SKY * moonScale * u_sky.u_night * u_sky.u_nightScale);
        let blend = smoothstep(0.0, -0.15, dir.y);
        col = mix(col, ground, blend);
    }

    // Bake LINEAR HDR radiance — no tonemap, no gamma — so the cubemap composites and feeds IBL in the
    // same linear space as the rest of the scene, and the single final tonemapper handles display.
    // `u_exposure` stays a linear "sky brightness" scale that composes with the camera's.
    return vec4<f32>(col * u_sky.u_exposure, 1.0);
}

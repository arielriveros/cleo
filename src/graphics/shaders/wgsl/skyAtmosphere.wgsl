// Physically-based sky (Nishita / O'Neil single scattering).
//
// Rendered once per cube face when the sun moves: the cube vertex stage hands each fragment its
// world-space sample direction. For every direction we raymarch a view ray through a spherical
// atmosphere, and at each sample raymarch toward the sun for the light optical depth (Beer
// extinction). Rayleigh (wavelength-dependent) gives the blue day sky and red sunsets; Mie gives the
// bright haze and aureole around the sun.
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
};
@group(0) @binding(0) var<uniform> u_sky: SkyUniforms;

/** Ray against a sphere at the origin. Returns (nearT, farT); nearT > farT means a miss. */
fn raySphere(ro: vec3<f32>, rd: vec3<f32>, r: f32) -> vec2<f32> {
    let b = dot(ro, rd);
    let c = dot(ro, ro) - r * r;
    var d = b * b - c;
    if (d < 0.0) { return vec2<f32>(1e9, -1e9); }
    d = sqrt(d);
    return vec2<f32>(-b - d, -b + d);
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

    var col = atmosphere(dir, ro, sunDir) * u_sky.u_sunColor;

    // Sun disk: only when looking toward the sun, the sun is above the horizon, and the view ray is
    // not looking into the ground. Mie forward-scatter has already tinted it by sunset.
    let viewPlanet = raySphere(ro, dir, u_sky.u_planetRadius);
    let viewHitsGround = viewPlanet.x > 0.0;
    let sunCos = dot(dir, sunDir);
    let diskCos = cos(radians(max(u_sky.u_sunDiskSize, 0.001)));
    if (!viewHitsGround && sunDir.y > -0.02 && sunCos > diskCos) {
        let disk = smoothstep(diskCos, mix(diskCos, 1.0, 0.35), sunCos);
        col += u_sky.u_sunColor * u_sky.u_sunIntensity * 0.35 * disk;
    }

    // Lower hemisphere: rays into the planet come back near-black, so blend a lit ground tint and the
    // bottom of the cubemap reads as ground rather than a void.
    if (viewHitsGround) {
        let lambert = max(sunDir.y, 0.0) * 0.9 + 0.1;
        let ground = u_sky.u_groundColor * lambert * u_sky.u_sunColor * (u_sky.u_sunIntensity * 0.05);
        let blend = smoothstep(0.0, -0.15, dir.y);
        col = mix(col, ground, blend);
    }

    // Bake LINEAR HDR radiance — no tonemap, no gamma — so the cubemap composites and feeds IBL in the
    // same linear space as the rest of the scene, and the single final tonemapper handles display.
    // `u_exposure` stays a linear "sky brightness" scale that composes with the camera's.
    return vec4<f32>(col * u_sky.u_exposure, 1.0);
}

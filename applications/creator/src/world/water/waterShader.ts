// The World preview's water: a FORWARD, TRANSPARENT custom material for seas and lakes, grown from the
// Valley pond's (tools/valley/water.glsl) for water that spans kilometres. Preview only: never exported.
//
// What changes for large water:
//   waves      four octaves of one tiling normal map at different scales and directions, the fine ones
//              fading with distance (no shimmering at the horizon) and the whole set slowly modulated by
//              a very coarse sample (no visible repeat across a bay)
//   depth      read from a texture of the terrain under it (height packed in R/G, shore distance in B)
//              rather than only the scene depth: depth = surface height - ground height is exact at any
//              distance, where a depth buffer has run out of precision. It drives the colour, the
//              absorption, the shore foam and the waves of foam that roll toward the beach.
//   sky        the Creator binds no environment map, so the reflection is the look's sky gradient
//   light      the engine's GGX sun glint and cascaded shadow, plus light scattered through wave faces
//
// Uniforms appear here as u_<name>; the prelude (customShaders.ts FORWARD) provides fragPos, u_viewPos,
// u_time, u_view, u_dirLight, u_sceneAmbient, fresnelSchlick, evaluateDirectionalLight,
// shadowCalculation and the scene helpers (cleoScreenUV, cleoSceneViewDepth, cleoSceneColor).

import type { CustomUniform } from 'cleo';

export const WATER_SOURCE = `
vec2 waveTap(vec2 uv) { return texture(u_normalMap, uv).xy * 2.0 - 1.0; }

mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

// Terrain height under a world point, metres; far below everything outside the map.
// textureLod, not texture: these run under branches, and WGSL allows only explicit-LOD sampling in
// non-uniform control flow (the texture has no mips anyway).
float groundAt(vec2 xz) {
    vec2 uv = xz / u_terrainSize + 0.5;
    vec4 t = textureLod(u_terrainHeight, clamp(uv, 0.0, 1.0), 0.0);
    float h = mix(u_terrainMin, u_terrainMax, (t.r * 65280.0 + t.g * 255.0) / 65535.0);
    bool outside = uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0;
    return outside ? u_terrainMin - 200.0 : h;
}

// Metres to the shore under a world point (positive out on the water), from the texture's blue.
float shoreAt(vec2 xz) {
    vec2 uv = xz / u_terrainSize + 0.5;
    float d = -(textureLod(u_terrainHeight, clamp(uv, 0.0, 1.0), 0.0).b * 2.0 - 1.0) * u_shoreRange;
    bool outside = uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0;
    return outside ? u_shoreRange : d;
}

// The surface slope (xz) at a point seen from \`dist\` metres: four octaves, the fine ones fading out.
vec2 waveSlope(vec2 xz, float dist, out float crest) {
    vec2 wind = u_windDir;
    float t = u_time * u_windSpeed;
    float s = 1.0 / max(u_waveScale, 0.1);
    float macro = 0.65 + 0.35 * waveTap(xz * s * 0.021 + vec2(0.13, 0.71)).x;
    vec2 o0 = waveTap(xz * s * 0.31 - wind * t * s * 0.31 * 0.55) * 1.0;
    vec2 o1 = waveTap(rot2(0.6) * xz * s + vec2(0.37, 0.61) - wind * t * s * 0.8) * 0.6;
    vec2 o2 = waveTap(rot2(-0.9) * xz * s * 2.63 + vec2(0.11, 0.29) - (wind * 0.8 + vec2(-wind.y, wind.x) * 0.25) * t * s * 1.6) * 0.3;
    vec2 o3 = waveTap(rot2(2.1) * xz * s * 6.9 + vec2(0.71, 0.17) - wind * t * s * 2.4) * 0.15;
    float fine = 1.0 - smoothstep(u_waveScale * 25.0, u_waveScale * 90.0, dist);
    float finer = 1.0 - smoothstep(u_waveScale * 8.0, u_waveScale * 35.0, dist);
    vec2 slope = (o0 + o1 + o2 * fine + o3 * finer) * u_waveStrength * macro;
    // Far away the surface reads as a calmer mirror: the eye cannot resolve the chop.
    slope *= mix(1.0, 0.35, smoothstep(u_waveScale * 60.0, u_waveScale * 600.0, dist));
    crest = clamp(length(o0 + o1) * 0.5 * macro, 0.0, 1.0);
    return slope;
}

vec3 skyReflection(vec3 R) {
    float up = clamp(R.y, 0.0, 1.0);
    return mix(u_skyHorizon, u_skyZenith, pow(up, 0.55));
}

vec4 fragment() {
    vec3 toEye = u_viewPos - fragPos;
    float dist = length(toEye);
    vec3 V = toEye / max(dist, 1e-4);
    float crest;
    vec2 slope = waveSlope(fragPos.xz, dist, crest);
    vec3 N = normalize(vec3(slope.x, 1.0, slope.y));
    float NoV = clamp(dot(N, V), 0.0, 1.0);
    bool below = u_viewPos.y < fragPos.y;

    // --- depth: from the terrain under the surface, and from the scene where it is near ----------
    float depth = max(fragPos.y - groundAt(fragPos.xz), 0.0);
    float path = depth / max(V.y, 0.08);          // what the view ray crosses to reach the bottom
    vec2 uv = cleoScreenUV();
    float fragDepth = cleoFragViewDepth();
    vec3 camForward = -vec3(u_view[0][2], u_view[1][2], u_view[2][2]);
    float axisToRay = 1.0 / max(dot(-V, camForward), 0.1);
    float sceneThickness = cleoHasScene() ? max(cleoSceneViewDepth(uv) - fragDepth, 0.0) * axisToRay : path;
    // Near the camera the depth buffer is the better witness (it sees rocks and props too).
    float nearW = 1.0 - smoothstep(60.0, 250.0, dist);
    path = mix(path, min(sceneThickness, path * 4.0 + 1.0), cleoHasScene() ? nearW : 0.0);

    // --- what lies under the water ------------------------------------------------------------------
    vec3 absorb = u_absorption / max(u_clarity, 0.05);
    vec2 offset = N.xz * u_refraction * clamp(depth, 0.0, 2.0) / max(fragDepth, 1.0);
    vec2 refractedUv = uv + offset;
    if (cleoHasScene() && cleoSceneViewDepth(refractedUv) < fragDepth) refractedUv = uv;
    vec3 bottom = cleoHasScene() ? cleoSceneColor(refractedUv) : u_shallowColor;
    vec3 transmitted = bottom * exp(-absorb * path);
    float visibility = 1.0 - shadowCalculation();
    vec3 L = dot(u_dirLight.direction, u_dirLight.direction) > 1e-6 ? normalize(-u_dirLight.direction) : vec3(0.0, 1.0, 0.0);
    vec3 sunLight = u_dirLight.color * u_dirLight.intensity;
    vec3 lit = u_sceneAmbient + sunLight * max(L.y, 0.0) * visibility / PI;
    // Light scattered back out of the water body, tending to the deep colour as the bottom fades away.
    float murk = 1.0 - exp(-path * (absorb.g + absorb.b) * 0.5);
    vec3 bodyColor = mix(u_shallowColor, u_deepColor, smoothstep(0.0, 1.0, murk)) * lit;
    vec3 body = mix(transmitted, bodyColor, murk);
    // Sun through the faces of waves: a turquoise glow on the crests between you and the sun.
    float through = pow(clamp(dot(-V, L) * 0.5 + 0.5, 0.0, 1.0), 4.0) * crest;
    body += u_shallowColor * sunLight * visibility * through * 0.04;

    // --- foam: at the waterline, in broken lines rolling toward the shore, on the steepest crests ------
    // No branches around the samples: implicit-derivative sampling must stay in uniform control flow.
    float shore = shoreAt(fragPos.xz);
    float breakup = 0.55 + 0.45 * waveTap(fragPos.xz * 0.37 + vec2(u_time * 0.03, 0.0)).y;
    float patches = smoothstep(0.3, 0.8, waveTap(fragPos.xz * 0.045 + vec2(0.31, u_time * 0.004)).x * 0.5 + 0.5);
    float edgeFoam = 1.0 - smoothstep(0.0, 0.4 + u_foam * 0.6, depth);
    float bandRange = 4.0 + u_foam * 10.0;
    float rolling = sin((shore / 6.0 + u_time * 0.25 * u_windSpeed) * 6.2831853);
    float bands = smoothstep(0.75, 1.0, rolling) * (1.0 - smoothstep(0.0, bandRange, shore))
                * smoothstep(0.0, 1.5, depth + 0.5) * clamp(u_windSpeed * 0.6, 0.0, 1.0) * patches * 0.6;
    float crestFoam = smoothstep(0.62, 0.95, crest) * 0.35 * patches;
    float foam = clamp((edgeFoam + bands + crestFoam) * u_foam * breakup, 0.0, 1.0);

    // --- surface -----------------------------------------------------------------------------------------
    vec3 R = reflect(-V, N);
    R.y = abs(R.y);
    vec3 reflection = skyReflection(R) * (0.35 + 0.65 * visibility);
    // Fresnel from the calm surface's angle, eased toward the wave normal's: grazing views of choppy water
    // would otherwise flicker between sky-white and the body colour from one wave facet to the next.
    float NoVflat = clamp(V.y, 0.0, 1.0);
    float F = below ? 0.0 : fresnelSchlick(mix(NoVflat, NoV, 0.35), vec3(0.02)).x * 0.9;
    vec3 glint = below ? vec3(0.0) : evaluateDirectionalLight(u_dirLight, N, V, vec3(0.0), 0.0, u_roughness, visibility);
    vec3 color = mix(body, reflection, F) + glint * (1.0 - foam);
    color = mix(color, lit * 0.9, foam);

    // Melt into the bank instead of a hard line where the water meets the ground.
    float edgeDepth = cleoHasScene() ? max(sceneThickness * max(V.y, 0.0), 0.0) : depth;
    float alpha = smoothstep(0.0, 0.25, min(edgeDepth, depth + 0.25));
    return vec4(color, alpha);
}
`;

/** The uniforms `WATER_SOURCE` declares, with neutral defaults (the stage writes the look over them). */
export const WATER_UNIFORMS: CustomUniform[] = [
  { name: 'normalMap', type: 'sampler2D', value: '' },
  { name: 'terrainHeight', type: 'sampler2D', value: '' },
  { name: 'terrainMin', type: 'float', value: 0 },
  { name: 'terrainMax', type: 'float', value: 1 },
  { name: 'terrainSize', type: 'float', value: 1000 },
  { name: 'shoreRange', type: 'float', value: 200 },
  { name: 'waveScale', type: 'float', value: 9 },
  { name: 'waveStrength', type: 'float', value: 0.45 },
  { name: 'windDir', type: 'vec2', value: [0.86, -0.5] },
  { name: 'windSpeed', type: 'float', value: 1.2 },
  { name: 'shallowColor', type: 'vec3', value: [0.05, 0.22, 0.24] },
  { name: 'deepColor', type: 'vec3', value: [0.004, 0.03, 0.07] },
  { name: 'absorption', type: 'vec3', value: [0.45, 0.09, 0.05] },
  { name: 'clarity', type: 'float', value: 2 },
  { name: 'foam', type: 'float', value: 0.6 },
  { name: 'roughness', type: 'float', value: 0.05 },
  { name: 'refraction', type: 'float', value: 0.3 },
  { name: 'skyHorizon', type: 'vec3', value: [0.62, 0.72, 0.82] },
  { name: 'skyZenith', type: 'vec3', value: [0.18, 0.34, 0.62] },
];

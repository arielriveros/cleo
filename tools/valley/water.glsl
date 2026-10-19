// Water — a FORWARD, TRANSPARENT custom material for flat, horizontal water surfaces (the Valley pond).
//
// What it does, per fragment:
//   waves       three samples of a tiling normal map in WORLD xz: two crossing ripple layers scrolling
//               along flowA / flowB, and a broad slow swell. World-space, so the waves never stretch
//               with the mesh and any number of quads meet seamlessly.
//   fresnel     Schlick at water's F0 (0.02, IOR 1.33): you see INTO the water looking down and a mirror
//               at grazing angles.
//   reflection  the light probe / environment cube when there is one, otherwise a sky gradient.
//   sun glint   the engine's own GGX sun at low roughness, shadowed by the cascades.
//   refraction  the opaque scene behind the water, offset by the wave normal and absorbed per channel
//               by how much water the ray crosses (Beer-Lambert), fading to deepColor in the deep.
//   ripples     expanding rings from whatever moves through the water — a wader's wake, a floating
//               crate's bob, a splash — fed by a WaterVolume node into ripple0..ripple11
//               ([x, z, startTime, strength], startTime on the u_time clock).
//   shore       an alpha that melts into the bank instead of a hard intersection line.
//
// Needs the engine's scene helpers (cleoScreenUV, cleoSceneViewDepth, cleoSceneColor), which are valid
// for TRANSPARENT materials: keep "transparent" on. Uniforms appear here as u_<name>.

// A tangent-space normal-map sample, unpacked to [-1, 1].
vec3 waveSample(vec2 uv) { return texture(u_normalMap, uv).xyz * 2.0 - 1.0; }

// One expanding ring: its surface SLOPE (xz) at `xz`, and its crest height for a little brightening.
// The ring runs outward at rippleSpeed; across it the surface is a damped sine (a crest, then a trough),
// and it fades with age and as it spreads (the energy of a ring is shared along its growing length).
vec2 rippleSlope(vec4 r, vec2 xz, inout float crest) {
    float age = u_time - r.z;
    if (age < 0.0 || age > u_rippleLife || r.w <= 0.0) return vec2(0.0);
    vec2 d = xz - r.xy;
    float dist = length(d);
    float front = age * u_rippleSpeed;
    float x = (dist - front) / u_rippleWidth;
    if (abs(x) > 3.0) return vec2(0.0);
    float fade = r.w * (1.0 - age / u_rippleLife) / (1.0 + front * 1.5);
    float envelope = exp(-x * x);
    // d/dx of sin(πx)·e^(-x²): the slope across the ring, pointing along the radius.
    float dh = (3.14159 * cos(3.14159 * x) - 2.0 * x * sin(3.14159 * x)) * envelope / u_rippleWidth;
    crest += max(sin(3.14159 * x), 0.0) * envelope * fade;
    return (dist > 1e-4 ? d / dist : vec2(0.0)) * dh * fade * u_rippleStrength;
}

// The wave normal in WORLD space for a horizontal surface: the map's x/y lie along world x/z. `crest`
// returns how much ripple crest is at this point.
vec3 waveNormal(vec2 xz, out float crest) {
    vec2 uv = xz * u_waveScale;
    vec3 a = waveSample(uv + u_time * u_flowA);
    vec3 b = waveSample(uv * 1.73 + vec2(0.37, 0.61) + u_time * u_flowB);
    vec3 c = waveSample(xz * u_swellScale + u_time * u_flowA * 0.21);
    // UDN blend: add the slopes, keep one "up".
    vec2 slope = (a.xy + b.xy) * u_waveStrength + c.xy * u_waveStrength * 0.6;
    crest = 0.0;
    // Separate uniforms cannot be indexed in a loop (and naga has no ## pasting): one call each.
    slope -= rippleSlope(u_ripple0, xz, crest);
    slope -= rippleSlope(u_ripple1, xz, crest);
    slope -= rippleSlope(u_ripple2, xz, crest);
    slope -= rippleSlope(u_ripple3, xz, crest);
    slope -= rippleSlope(u_ripple4, xz, crest);
    slope -= rippleSlope(u_ripple5, xz, crest);
    slope -= rippleSlope(u_ripple6, xz, crest);
    slope -= rippleSlope(u_ripple7, xz, crest);
    slope -= rippleSlope(u_ripple8, xz, crest);
    slope -= rippleSlope(u_ripple9, xz, crest);
    slope -= rippleSlope(u_ripple10, xz, crest);
    slope -= rippleSlope(u_ripple11, xz, crest);
    return normalize(vec3(slope.x, 1.0, slope.y));
}

vec3 skyFallback(vec3 R) {
    float up = clamp(R.y, 0.0, 1.0);
    vec3 horizon = u_skyColor * 0.55 + u_sceneAmbient * 0.15;
    return mix(horizon, u_skyColor, pow(up, 0.6));
}

vec4 fragment() {
    float crest;
    vec3 N = waveNormal(fragPos.xz, crest);
    vec3 V = normalize(u_viewPos - fragPos);
    float NoV = clamp(dot(N, V), 0.0, 1.0);
    // Seen from BELOW the surface (a camera under the water line): no reflection, just the body.
    bool below = u_viewPos.y < fragPos.y;

    // --- reflection --------------------------------------------------------------------------------
    vec3 R = reflect(-V, N);
    R.y = abs(R.y);                       // never reflect the ground under a horizontal mirror
    vec3 reflection = skyFallback(R);
    if (u_useEnvMap) {
        vec3 e = textureLod(u_envMap, R, u_roughness * 4.0).rgb;
        reflection = u_envMapLinear ? e : toLinear(e);
    }
    float F = below ? 0.0 : fresnelSchlick(NoV, vec3(0.02)).x;
    F = clamp(F * u_reflectivity, 0.0, 1.0);

    // --- what lies under the water -----------------------------------------------------------------
    vec2 uv = cleoScreenUV();
    float fragDepth = cleoFragViewDepth();
    float thickness = cleoHasScene() ? max(cleoSceneViewDepth(uv) - fragDepth, 0.0) : 4.0;
    // The scene depths are measured along the CAMERA AXIS. Turned into the distance the view ray travels
    // through the water (what absorbs), and into the water's vertical depth (what decides the shore):
    // looking across a shallow pond the ray crosses metres of water over a few centimetres of depth,
    // and using one for the other puts the soft shore edge metres out in front of the camera.
    vec3 camForward = -vec3(u_view[0][2], u_view[1][2], u_view[2][2]);
    float axisToRay = 1.0 / max(dot(-V, camForward), 0.1);
    float depthBelow = thickness * axisToRay * max(V.y, 0.0);

    // Refract: offset by the wave slope, more through more water, and never pick up something that is
    // IN FRONT of the water (its depth would come back nearer than the surface) — the classic leak.
    vec2 offset = N.xz * u_refraction * clamp(depthBelow, 0.0, 1.0) / max(fragDepth, 1.0);
    vec2 refractedUv = uv + offset;
    float refractedThickness = cleoHasScene() ? cleoSceneViewDepth(refractedUv) - fragDepth : thickness;
    if (refractedThickness < 0.0) { refractedUv = uv; refractedThickness = thickness; }
    // Path length through the water, for the absorption below.
    refractedThickness = max(refractedThickness, 0.0) * axisToRay;

    vec3 behind = cleoHasScene() ? cleoSceneColor(refractedUv) : u_deepColor;
    // Beer-Lambert along the ray, then in-scattering toward the water's own colour with depth.
    vec3 transmitted = behind * exp(-u_absorption * refractedThickness);
    float murk = 1.0 - exp(-refractedThickness * u_turbidity);
    // Light scattered back out of the water body: a Lambert medium under the ambient fill and the sun.
    float visibility = 1.0 - shadowCalculation();
    vec3 L = dot(u_dirLight.direction, u_dirLight.direction) > 1e-6 ? normalize(-u_dirLight.direction) : vec3(0.0, 1.0, 0.0);
    vec3 lit = u_sceneAmbient + u_dirLight.color * u_dirLight.intensity * max(L.y, 0.0) * visibility / PI;
    vec3 bodyColor = mix(u_shallowColor, u_deepColor, clamp(refractedThickness / u_deepDistance, 0.0, 1.0)) * lit;
    vec3 body = mix(transmitted, bodyColor, murk);

    // Ripple crests catch a little more light: churned water scatters more.
    body += lit * u_shallowColor * clamp(crest, 0.0, 1.0) * u_crestBrightness;

    // --- sun -----------------------------------------------------------------------------------------
    vec3 glint = below ? vec3(0.0)
        : evaluateDirectionalLight(u_dirLight, N, V, vec3(0.0), 0.0, u_roughness, visibility) * u_specularStrength;

    vec3 color = mix(body, reflection, F) + glint;
    // Melt into the bank: fully transparent where the water is a film, opaque once it has any depth.
    float alpha = cleoHasScene() ? smoothstep(0.0, u_edgeSoftness, depthBelow) : 1.0;
    return vec4(color, alpha);
}

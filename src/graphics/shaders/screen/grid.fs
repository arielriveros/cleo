#version 300 es

// Infinite editor reference grid drawn as a single fullscreen pass.
// For every pixel we reconstruct a world-space ray from the inverse view-projection,
// intersect it with the grid plane, and draw anti-aliased lines using screen-space
// derivatives (fwidth). Depth is written from the world hit so scene geometry occludes
// the grid correctly. Line density adapts to zoom: a 0.1u subgrid fades in when zoomed
// in for precise positioning, and 1u / 10u levels cross-fade so the grid never aliases
// into moire when zoomed out.

precision highp float;

in vec2 fragTexCoord;

layout(location = 0) out vec4 fragColor;

uniform mat4  u_invViewProj; // reconstruct the per-pixel world ray
uniform mat4  u_viewProj;    // project the world hit -> gl_FragDepth
uniform vec3  u_viewPos;     // camera world position (distance fade)
uniform int   u_plane;       // 0 = XZ ground plane (3D), 1 = XY front plane (2D)
uniform float u_fadeFar;     // world-space radius where the grid fully fades out

// Anti-aliased grid coverage for a given cell size. Returns ~1 on a line, 0 inside a
// cell, feathered to roughly one pixel wide regardless of zoom.
float gridLine(vec2 coord, float scale) {
    vec2 g = coord / scale;
    vec2 d = fwidth(g);
    vec2 l = abs(fract(g - 0.5) - 0.5) / max(d, 1e-8);
    return 1.0 - clamp(min(l.x, l.y), 0.0, 1.0);
}

// Anti-aliased coverage for a single center axis at c == 0. Measures distance from the
// axis in *pixels* using c's own screen-space derivative, so the line keeps a constant
// ~1px width instead of smearing into a wide band at grazing/horizon angles.
float axisLine(float c) {
    float d = fwidth(c);
    return 1.0 - clamp(abs(c) / max(d, 1e-8) - 1.0, 0.0, 1.0);
}

void main() {
    // 1. Reconstruct the world-space ray through this pixel (near -> far).
    vec2 ndc = fragTexCoord * 2.0 - 1.0;
    vec4 nW = u_invViewProj * vec4(ndc, -1.0, 1.0);
    vec4 fW = u_invViewProj * vec4(ndc,  1.0, 1.0);
    vec3 ro = nW.xyz / nW.w;
    vec3 rd = fW.xyz / fW.w - ro;

    // 2. Intersect the grid plane (Y=0 for XZ, Z=0 for XY).
    float denom = (u_plane == 0) ? rd.y : rd.z;
    float orig  = (u_plane == 0) ? ro.y : ro.z;
    if (abs(denom) < 1e-6) discard;          // ray parallel to the plane
    float t = -orig / denom;
    if (t < 0.0 || t > 1.0) discard;         // behind the camera or beyond far
    vec3 hit = ro + t * rd;
    vec2 coord = (u_plane == 0) ? hit.xz : hit.xy;

    // 3. Depth for correct occlusion. depthMask is off during this pass, so this value
    //    is only used for the LEQUAL test (not written): geometry in front hides the grid.
    vec4 clip = u_viewProj * vec4(hit, 1.0);
    gl_FragDepth = (clip.z / clip.w) * 0.5 + 0.5;

    // 4. Adaptive multi-level lines. Coverage = pixels spanned by one cell; each level
    //    fades based on how many pixels its cells occupy so density stays readable.
    float px = max(fwidth(coord.x), fwidth(coord.y)); // world units per pixel

    float minorFade  = smoothstep(6.0, 20.0, 0.1 / px); // subgrid: appears when zoomed in
    float majorFade  = smoothstep(2.0,  8.0, 1.0 / px); // primary 1u: fades out far away
    float coarseFade = smoothstep(2.0,  8.0, 10.0 / px);// 10u: carries the far view

    float minor  = gridLine(coord, 0.1)  * minorFade;
    float major  = gridLine(coord, 1.0)  * majorFade;
    float coarse = gridLine(coord, 10.0) * coarseFade;

    float a = 0.0;
    a = max(a, minor * 0.45); // subgrid dimmer than the primary lines
    a = max(a, major);
    a = max(a, coarse);
    vec3 col = vec3(0.55);

    // 5. Colored center axes baked into the grid (the two in-plane axes). AA, constant
    //    pixel width (see axisLine) so they stay thin and don't band out at the horizon.
    // coord.y == 0 is the X axis in both planes (points with z=0 or y=0) -> red.
    // coord.x == 0 is the in-plane depth/vertical axis -> Z (ground, blue) or Y (front, green).
    float xAxis = axisLine(coord.x);
    float yAxis = axisLine(coord.y);
    if (yAxis > 0.0) { col = vec3(0.90, 0.25, 0.25); a = max(a, yAxis); } // X = red
    if (xAxis > 0.0) {
        col = (u_plane == 0) ? vec3(0.25, 0.45, 0.95)  // Z = blue (3D ground)
                             : vec3(0.30, 0.85, 0.35); // Y = green (2D front)
        a = max(a, xAxis);
    }

    // 6. Distance fade => infinite illusion and no far-field shimmer.
    float dist = length(hit - u_viewPos);
    a *= 1.0 - smoothstep(u_fadeFar * 0.5, u_fadeFar, dist);

    if (a <= 0.0) discard;
    fragColor = vec4(col, a);
}
